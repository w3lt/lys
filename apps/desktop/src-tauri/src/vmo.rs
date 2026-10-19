//! Ownership and Tauri commands for vmo, Lys's page reader.
//!
//! vmo reads pages for the backend's `read_page` tool, each in a micro VM of
//! its own. The desktop owns at most one vmo child, as it owns the backend.
//! Development builds run `apps/vmo/run.sh`, which builds vmo and then becomes
//! it; release builds run the binary that `build.sh` installs under the Lys
//! home. The child runs in its own Unix process group.
//!
//! A stop sends `SIGTERM` once and gives vmo up to [`VMO_STOP_TIMEOUT`] to cut
//! open reads short and delete its VMs before it sends `SIGKILL`. vmo ends at
//! once on a second signal, skipping that cleanup, so a stop that is already
//! waiting is joined rather than repeated. The health check asks vmo's
//! `GET /health` route from here because vmo answers only once it can read
//! pages and sends no CORS headers the renderer could read an answer through.

use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError},
    thread,
    time::{Duration, Instant},
};

use nix::{
    errno::Errno,
    sys::signal::{killpg, Signal},
    unistd::Pid,
};
use tauri::{AppHandle, Manager, State};

use crate::utils::lys_home::LysHome;

/// Longest time a stop waits for vmo to exit after `SIGTERM` before it sends
/// `SIGKILL`: long enough for vmo to delete the VMs of the reads it cut short.
pub const VMO_STOP_TIMEOUT: Duration = Duration::from_secs(60);

/// How often a stop checks whether vmo has exited.
const VMO_EXIT_CHECK_INTERVAL: Duration = Duration::from_millis(100);

/// Time limit of each health check, from connecting to reading the status line.
const VMO_HEALTH_TIMEOUT: Duration = Duration::from_secs(1);

/// Most bytes of vmo's answer a health check reads while looking for the end
/// of its status line.
const MAX_VMO_STATUS_LINE_BYTES: usize = 64;

/// Status line that starts every answer meaning vmo can read pages.
const VMO_HEALTHY_STATUS_LINE_PREFIX: &[u8] = b"HTTP/1.1 200 ";

/// Loopback address on which vmo listens.
///
/// It must equal `VMO_HOST` and `VMO_PORT` in
/// `packages/protocol/src/constant.ts`, which the backend and the renderer
/// use, and the default host and port of vmo's `WebServer` in `apps/vmo`.
const VMO_ADDRESS: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8080);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
/// Lifecycle stage of the vmo child the desktop owns, as the renderer receives
/// it: `{ "status": "stopped" }`, or `running` and `stopping` with a `pid`.
pub enum VmoProcessStatus {
    /// No child is owned, or the owned child has exited.
    Stopped,
    /// The owned child has not exited and no stop has taken it.
    Running {
        /// Operating-system process identifier of the child.
        pid: u32,
    },
    /// A stop has sent `SIGTERM` to the child and is waiting for it to exit.
    Stopping {
        /// Operating-system process identifier of the child.
        pid: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
/// How a stop ended vmo, as the renderer receives it: `{ "status": "stopped" }`
/// or `{ "status": "killed" }`.
pub enum VmoStopOutcome {
    /// vmo exited within the stop timeout, or no running child was owned.
    Stopped,
    /// vmo still ran when the stop timeout passed and was killed with
    /// `SIGKILL`, so VMs it had not deleted yet may still run.
    Killed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
/// Whether vmo answered its health route, as the renderer receives it:
/// `"ready"` or `"not-ready"`.
pub enum VmoHealth {
    /// vmo answered `GET /health` with `200 OK`, so it can read pages.
    Ready,
    /// Nothing answered within the time limit, or the answer was not `200 OK`.
    NotReady,
}

/// Result of one stop, shared by its caller and every stop that joined it.
type VmoStopResult = Result<VmoStopOutcome, String>;

#[derive(Default)]
/// Result of one stop, published once to every caller waiting for it.
///
/// A poisoned lock is recovered: the result is written in one assignment, so
/// a panic cannot leave it half written.
struct VmoStopSettlement {
    /// The stop's result once it has settled; `None` before.
    result: Mutex<Option<VmoStopResult>>,
    /// Notified once `result` is set.
    settled: Condvar,
}

impl VmoStopSettlement {
    /// Publishes the stop's result and wakes every caller waiting for it.
    fn resolve(&self, result: VmoStopResult) {
        let mut settled_result = self.result.lock().unwrap_or_else(PoisonError::into_inner);
        *settled_result = Some(result);
        self.settled.notify_all();
    }

    /// Waits until the stop has settled and returns a copy of its result.
    fn wait_for_result(&self) -> VmoStopResult {
        let mut settled_result = self.result.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if let Some(result) = settled_result.as_ref() {
                return result.clone();
            }
            settled_result = self
                .settled
                .wait(settled_result)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

/// The vmo child the desktop owns, by lifecycle stage.
enum VmoProcess {
    /// No child is owned.
    Stopped,
    /// A spawned child no stop has taken; it may have exited on its own.
    Running(Child),
    /// A stop took the child, sent it `SIGTERM`, and waits for it to exit.
    Stopping {
        /// Operating-system process identifier of the child.
        pid: u32,
        /// Where that stop publishes its result for the stops that join it.
        settlement: Arc<VmoStopSettlement>,
    },
}

/// What a stop found when it took the lock.
enum VmoStopAdmission {
    /// No running child is owned, so the stop has nothing to do.
    NothingRunning,
    /// Another stop is waiting for the child; this stop shares its result.
    Joined(Arc<VmoStopSettlement>),
    /// This stop took the running child and publishes the result.
    Admitted {
        /// The child to stop, now owned by the stop.
        child: Child,
        /// Where the result is published for the stops that join this one.
        settlement: Arc<VmoStopSettlement>,
    },
}

/// Owns the vmo child process to start, stop, and report vmo while keeping
/// two rules: at most one child is owned, and a child receives `SIGTERM` at
/// most once.
///
/// The state is one [`VmoProcess`] behind a mutex, and every operation reads
/// or changes it within one lock. A stop releases the lock while it waits for
/// vmo to exit, so a status read or another stop never waits behind that
/// wait. Concurrency model: concurrent. `start`, `status`, and the admission
/// of a stop are serialized by the lock; the waits of stops overlap them. The
/// owned child is released only by [`Vmo::stop`]: dropping a `Vmo` leaves the
/// child running, so the application stops it when it exits. A poisoned lock
/// is recovered, because every change of the state is one assignment.
pub struct Vmo {
    /// Owned child, by lifecycle stage.
    process: Mutex<VmoProcess>,
    /// Longest time a stop waits after `SIGTERM` before it sends `SIGKILL`.
    stop_timeout: Duration,
}

impl Vmo {
    /// Creates an owner that owns no child, without starting anything.
    ///
    /// `stop_timeout` is the longest time a stop waits for vmo to exit after
    /// `SIGTERM`; the application passes [`VMO_STOP_TIMEOUT`].
    pub fn new(stop_timeout: Duration) -> Self {
        Self {
            process: Mutex::new(VmoProcess::Stopped),
            stop_timeout,
        }
    }

    /// Starts `command` as the vmo child unless a child already runs.
    ///
    /// A running child is left alone and its status returned. Otherwise
    /// `command` is spawned in a new process group of its own and stored,
    /// replacing an exited child. The check and the spawn share one lock, so
    /// two starts never spawn two children.
    ///
    /// # Errors
    ///
    /// Returns an error while a stop is waiting for the previous child, which
    /// still holds vmo's port, when the owned child cannot be inspected, or
    /// when `command` cannot be spawned; that error names the program, so a
    /// missing install shows where vmo was expected.
    pub fn start(&self, mut command: Command) -> Result<VmoProcessStatus, String> {
        let mut process = self.get_locked_process();
        match &mut *process {
            VmoProcess::Stopping { .. } => {
                return Err(String::from(
                    "vmo is still stopping; start it again once it has stopped",
                ));
            }
            VmoProcess::Running(child) => {
                if let Some(pid) = find_running_vmo_pid(child)? {
                    return Ok(VmoProcessStatus::Running { pid });
                }
            }
            VmoProcess::Stopped => {}
        }

        let child = command.process_group(0).spawn().map_err(|err| {
            format!(
                "Failed to run {}: {err}",
                Path::new(command.get_program()).display()
            )
        })?;
        let pid = child.id();
        *process = VmoProcess::Running(child);
        Ok(VmoProcessStatus::Running { pid })
    }

    /// Reports the owned child's lifecycle stage without blocking.
    ///
    /// An exited child is reported as stopped and stays stored until a start
    /// replaces it or a stop removes it.
    ///
    /// # Errors
    ///
    /// Returns an error when the operating system cannot inspect the child.
    pub fn status(&self) -> Result<VmoProcessStatus, String> {
        let mut process = self.get_locked_process();
        match &mut *process {
            VmoProcess::Stopped => Ok(VmoProcessStatus::Stopped),
            VmoProcess::Running(child) => Ok(find_running_vmo_pid(child)?
                .map_or(VmoProcessStatus::Stopped, |pid| VmoProcessStatus::Running {
                    pid,
                })),
            VmoProcess::Stopping { pid, .. } => Ok(VmoProcessStatus::Stopping { pid: *pid }),
        }
    }

    /// Stops the owned child and waits until it has exited.
    ///
    /// Without a running child it returns `Stopped` at once and forgets an
    /// exited child. Otherwise it sends `SIGTERM` to the child's process group,
    /// waits up to the stop timeout for the child to exit, and then sends
    /// `SIGKILL` to the group and waits again. The wait happens without the
    /// lock, which reports `stopping` meanwhile. A stop called during that
    /// wait sends nothing and returns the same result once the first settles.
    /// The call blocks for up to the stop timeout, so callers keep it off the
    /// main thread except during application exit.
    ///
    /// # Errors
    ///
    /// Returns an error when the child cannot be inspected, signalled, or
    /// waited for. The child is then killed and waited for as far as possible,
    /// and the owner holds no child afterwards.
    pub fn stop(&self) -> VmoStopResult {
        let (child, settlement) = match self.update_process_for_stop()? {
            VmoStopAdmission::NothingRunning => return Ok(VmoStopOutcome::Stopped),
            VmoStopAdmission::Joined(settlement) => return settlement.wait_for_result(),
            VmoStopAdmission::Admitted { child, settlement } => (child, settlement),
        };

        let result = stop_vmo_child(child, self.stop_timeout);
        // Leave `Stopping` before publishing, so a caller woken by the result
        // can start vmo again at once.
        *self.get_locked_process() = VmoProcess::Stopped;
        settlement.resolve(result.clone());
        result
    }

    /// Gets the owned child's state under its lock, recovering a poisoned
    /// lock.
    fn get_locked_process(&self) -> MutexGuard<'_, VmoProcess> {
        self.process.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Updates the owned child's state for a stop, within one lock, and says
    /// what the stop does: nothing, join the stop in progress, or take the
    /// running child, leaving the state `Stopping`.
    ///
    /// # Errors
    ///
    /// Returns an error when the owned child cannot be inspected; the child
    /// then stays owned as it was.
    fn update_process_for_stop(&self) -> Result<VmoStopAdmission, String> {
        let mut process = self.get_locked_process();
        match std::mem::replace(&mut *process, VmoProcess::Stopped) {
            VmoProcess::Stopped => Ok(VmoStopAdmission::NothingRunning),
            VmoProcess::Stopping { pid, settlement } => {
                let joined = Arc::clone(&settlement);
                *process = VmoProcess::Stopping { pid, settlement };
                Ok(VmoStopAdmission::Joined(joined))
            }
            VmoProcess::Running(mut child) => match child.try_wait() {
                Ok(Some(_exit_status)) => Ok(VmoStopAdmission::NothingRunning),
                Ok(None) => {
                    let settlement = Arc::new(VmoStopSettlement::default());
                    *process = VmoProcess::Stopping {
                        pid: child.id(),
                        settlement: Arc::clone(&settlement),
                    };
                    Ok(VmoStopAdmission::Admitted { child, settlement })
                }
                Err(err) => {
                    *process = VmoProcess::Running(child);
                    Err(format!("Failed to inspect vmo process: {err}"))
                }
            },
        }
    }
}

/// Finds the process identifier of `child` while it has not exited.
///
/// `try_wait` does not block; it reaps a child that has exited.
///
/// # Errors
///
/// Returns an error when the operating system cannot inspect the child.
fn find_running_vmo_pid(child: &mut Child) -> Result<Option<u32>, String> {
    match child.try_wait() {
        Ok(None) => Ok(Some(child.id())),
        Ok(Some(_exit_status)) => Ok(None),
        Err(err) => Err(format!("Failed to inspect vmo process: {err}")),
    }
}

/// Stops one vmo child: `SIGTERM` to its process group, up to `stop_timeout`
/// for it to exit, then `SIGKILL` to the group and a wait for the child.
///
/// # Errors
///
/// Returns an error when the group cannot be signalled for a reason other
/// than being gone, or the child cannot be inspected or waited for. The group
/// is then sent `SIGKILL` and the child waited for, and a failure of that is
/// added to the error.
fn stop_vmo_child(mut child: Child, stop_timeout: Duration) -> VmoStopResult {
    let pid = child.id();
    send_sigterm_and_wait_for_vmo(&mut child, stop_timeout)
        .map_err(|error| match send_sigkill_and_wait_for_vmo(&mut child) {
            Ok(()) => error,
            Err(cleanup_error) => format!("{error}; {cleanup_error}"),
        })
        .map_err(|error| format!("Failed to stop vmo process {pid}: {error}"))
}

/// Sends `SIGTERM` to the child's process group and waits up to
/// `stop_timeout` for the child to exit, then kills it if it still runs.
///
/// # Errors
///
/// Returns an error when signalling, inspecting, or waiting fails.
fn send_sigterm_and_wait_for_vmo(child: &mut Child, stop_timeout: Duration) -> VmoStopResult {
    send_vmo_signal(child.id(), Signal::SIGTERM)?;
    if wait_for_vmo_exit(child, stop_timeout)? {
        return Ok(VmoStopOutcome::Stopped);
    }
    send_sigkill_and_wait_for_vmo(child)?;
    Ok(VmoStopOutcome::Killed)
}

/// Sends `SIGKILL` to the child's process group and waits for the child.
///
/// # Errors
///
/// Returns an error when signalling or waiting fails.
fn send_sigkill_and_wait_for_vmo(child: &mut Child) -> Result<(), String> {
    send_vmo_signal(child.id(), Signal::SIGKILL)?;
    child
        .wait()
        .map(|_exit_status| ())
        .map_err(|err| format!("failed to wait for it: {err}"))
}

/// Sends `signal` to the Unix process group whose identifier is `pid`.
///
/// The child was spawned as the leader of that group, so the signal reaches
/// vmo and, in development, the build `run.sh` runs before it becomes vmo. A
/// group that is already gone counts as signalled.
///
/// # Errors
///
/// Returns an error when `pid` is outside the range of a Unix process
/// identifier or Unix refuses the signal for a reason other than `ESRCH`.
fn send_vmo_signal(pid: u32, signal: Signal) -> Result<(), String> {
    let process_group = i32::try_from(pid)
        .map(Pid::from_raw)
        .map_err(|_| format!("process group {pid} is outside the supported range"))?;
    match killpg(process_group, signal) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(err) => Err(format!(
            "failed to send {signal} to its process group: {err}"
        )),
    }
}

/// Waits until `child` exits or `timeout` passes, checking every
/// [`VMO_EXIT_CHECK_INTERVAL`].
///
/// Returns whether the child exited.
///
/// # Errors
///
/// Returns an error when the operating system cannot inspect the child.
fn wait_for_vmo_exit(child: &mut Child, timeout: Duration) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let has_exited = child
            .try_wait()
            .map_err(|err| format!("failed to inspect it: {err}"))?
            .is_some();
        if has_exited {
            return Ok(true);
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        thread::sleep(VMO_EXIT_CHECK_INTERVAL.min(deadline - now));
    }
}

/// Sends one `GET /health` request to vmo at `address` and reports whether it
/// answered `200 OK`.
///
/// Connecting, sending, and reading the status line all happen within
/// `timeout`. Only the status line is read; a refused connection, a timeout,
/// or any other status means vmo is not ready.
fn send_vmo_health_check(address: SocketAddr, timeout: Duration) -> VmoHealth {
    match read_vmo_health_status_line(address, timeout) {
        Ok(status_line) if status_line.starts_with(VMO_HEALTHY_STATUS_LINE_PREFIX) => {
            VmoHealth::Ready
        }
        Ok(_) | Err(_) => VmoHealth::NotReady,
    }
}

/// Sends `GET /health` to `address` and reads the answer's status line.
///
/// Returns at most [`MAX_VMO_STATUS_LINE_BYTES`] bytes, ending with `\r\n`
/// unless the answer ended or the limit was reached first.
///
/// # Errors
///
/// Returns the I/O error of connecting, sending, or reading, including a
/// timeout once `timeout` has passed since the call began.
fn read_vmo_health_status_line(address: SocketAddr, timeout: Duration) -> std::io::Result<Vec<u8>> {
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect_timeout(&address, timeout)?;
    stream.set_write_timeout(Some(find_remaining_time(deadline)?))?;
    stream.write_all(
        format!("GET /health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").as_bytes(),
    )?;

    let mut status_line = Vec::with_capacity(MAX_VMO_STATUS_LINE_BYTES);
    let mut buffer = [0_u8; MAX_VMO_STATUS_LINE_BYTES];
    while status_line.len() < MAX_VMO_STATUS_LINE_BYTES && !status_line.ends_with(b"\r\n") {
        stream.set_read_timeout(Some(find_remaining_time(deadline)?))?;
        let wanted = MAX_VMO_STATUS_LINE_BYTES - status_line.len();
        let read = stream.read(&mut buffer[..wanted])?;
        if read == 0 {
            break;
        }
        status_line.extend_from_slice(&buffer[..read]);
    }
    Ok(status_line)
}

/// Finds the time left until `deadline`.
///
/// # Errors
///
/// Returns a `TimedOut` error once the deadline has passed, because a socket
/// timeout of zero would mean no timeout at all.
fn find_remaining_time(deadline: Instant) -> std::io::Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "the vmo health check ran out of time",
        ));
    }
    Ok(remaining)
}

/// Resolves the repository's vmo package directory from the Tauri crate
/// location: `apps/vmo`, beside `apps/desktop`.
///
/// # Errors
///
/// Returns an error if the manifest path does not have the expected parents.
fn get_vmo_dir() -> Result<PathBuf, String> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| String::from("Failed to resolve apps directory"))?
        .join("vmo"))
}

/// Builds the command that runs vmo for the current build mode.
///
/// Development builds run `bash run.sh` in `apps/vmo`, which builds and signs
/// a debug vmo and then becomes it. Release builds run the vmo binary that
/// `build.sh` installs under `lys_home`. Neither reads `LYS_HOME`.
///
/// # Errors
///
/// Returns an error when the development vmo directory cannot be resolved.
fn build_vmo_command(lys_home: &LysHome) -> Result<Command, String> {
    if tauri::is_dev() {
        let mut command = Command::new("bash");
        command.arg("run.sh").current_dir(get_vmo_dir()?);
        Ok(command)
    } else {
        Ok(Command::new(lys_home.vmo_executable_path()))
    }
}

#[tauri::command]
/// Starts vmo unless the desktop already owns a running vmo.
///
/// A running child is left alone and its status returned; otherwise vmo for
/// the current build mode is spawned in its own process group. Spawning
/// returns at once: vmo first pulls its images, which took about three
/// minutes the first time, and answers `get_vmo_health` only after that.
///
/// # Errors
///
/// Returns an error while a stop is still waiting for the previous vmo, or
/// when the development directory cannot be resolved, the child cannot be
/// inspected, or vmo cannot be spawned, for example because `build.sh` has
/// not installed it.
pub fn start_vmo(
    vmo: State<'_, Vmo>,
    lys_home: State<'_, LysHome>,
) -> Result<VmoProcessStatus, String> {
    vmo.start(build_vmo_command(&lys_home)?)
}

#[tauri::command]
/// Reads the lifecycle stage of the vmo the desktop owns, without blocking.
///
/// # Errors
///
/// Returns an error when the child cannot be inspected.
pub fn get_vmo_status(vmo: State<'_, Vmo>) -> Result<VmoProcessStatus, String> {
    vmo.status()
}

#[tauri::command]
/// Stops the vmo the desktop owns, waiting until it has exited.
///
/// vmo gets `SIGTERM` once and up to one minute to delete its VMs before it
/// is killed, which the outcome reports as `killed`. The wait runs on Tauri's
/// blocking-task pool, so the window stays responsive; it cannot be
/// cancelled. A stop called while another waits joins it.
///
/// # Errors
///
/// Returns an error when the child cannot be inspected, signalled, or waited
/// for, or when the blocking task ends unexpectedly.
pub async fn stop_vmo(app: AppHandle) -> VmoStopResult {
    tauri::async_runtime::spawn_blocking(move || app.state::<Vmo>().stop())
        .await
        .map_err(|err| format!("The vmo stop ended unexpectedly: {err}"))?
}

#[tauri::command]
/// Asks vmo's `GET /health` route on `127.0.0.1:8080` whether vmo can read
/// pages.
///
/// The check takes at most about one second and runs on Tauri's
/// blocking-task pool. It asks whichever process listens on vmo's port, also a
/// vmo the desktop does not own.
///
/// # Errors
///
/// Returns an error only when the blocking task ends unexpectedly.
pub async fn get_vmo_health() -> Result<VmoHealth, String> {
    tauri::async_runtime::spawn_blocking(|| {
        send_vmo_health_check(SocketAddr::V4(VMO_ADDRESS), VMO_HEALTH_TIMEOUT)
    })
    .await
    .map_err(|err| format!("The vmo health check ended unexpectedly: {err}"))
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::{Read, Write},
        net::{SocketAddr, TcpListener, TcpStream},
        path::Path,
        process::{Command, Stdio},
        sync::{mpsc, Arc, Barrier},
        thread,
        time::{Duration, Instant},
    };

    use nix::{sys::signal::kill, unistd::Pid};
    use serde_json::{json, to_value};

    use super::{send_vmo_health_check, Vmo, VmoHealth, VmoProcessStatus, VmoStopOutcome};
    use crate::tools::test_directory::TestDirectory;

    /// Stop timeout of the cases whose child ignores `SIGTERM`.
    const SHORT_STOP_TIMEOUT: Duration = Duration::from_millis(300);

    /// Stop timeout of the cases whose child exits on `SIGTERM`; never reached.
    const LONG_STOP_TIMEOUT: Duration = Duration::from_secs(30);

    /// Stop timeout of the joined-stop case: the margin within which the
    /// joining stop has to reach the owner after the first stop's `SIGTERM`.
    const JOINED_STOP_TIMEOUT: Duration = Duration::from_secs(5);

    /// Longest any case waits for a condition before it fails.
    const CONDITION_LIMIT: Duration = Duration::from_secs(10);

    /// Script of a child that exits on `SIGTERM`.
    const EXITS_ON_SIGTERM: &str = "trap 'exit 0' TERM; while :; do sleep 0.02; done";

    /// Stops the case's vmo child when dropped, so that a failed assertion or
    /// setup step leaves no shell running after the test.
    ///
    /// A stop failure fails the test unless the test is already failing, so
    /// that the original failure stays the reported one.
    struct VmoStopGuard(Arc<Vmo>);

    impl Drop for VmoStopGuard {
        /// Stops the case's vmo child and waits until it has exited.
        fn drop(&mut self) {
            if let Err(error) = self.0.stop() {
                assert!(thread::panicking(), "stop the case's vmo child: {error}");
            }
        }
    }

    /// Creates an owner with `stop_timeout` together with the guard that stops
    /// its child when the case ends, before the case starts anything.
    fn create_guarded_vmo(stop_timeout: Duration) -> (Arc<Vmo>, VmoStopGuard) {
        let vmo = Arc::new(Vmo::new(stop_timeout));
        let guard = VmoStopGuard(Arc::clone(&vmo));
        (vmo, guard)
    }

    /// Builds a command that runs `script` with `sh`, discarding what the
    /// shell reports about the jobs a signal ended.
    fn build_shell_command(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.arg("-c").arg(script).stderr(Stdio::null());
        command
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

    /// Reads the number of lines of `path`, or zero while it does not exist.
    fn read_line_count(path: &Path) -> usize {
        fs::read_to_string(path).map_or(0, |text| text.lines().count())
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

    /// Starts a child that runs `trap_action` on `SIGTERM` and keeps running
    /// otherwise, with a background `sleep` in its process group, and waits
    /// until it has set that trap: a signal sent before would end it at once.
    ///
    /// The `sleep` starts after the trap is set, so it inherits an ignored
    /// `SIGTERM` but not a trap's action. Returns the child's pid and the
    /// `sleep`'s.
    fn start_trapping_child(vmo: &Vmo, case: &TestDirectory, trap_action: &str) -> (u32, i32) {
        let ready = case.path().join("ready");
        let descendant = case.path().join("descendant.pid");
        let script = format!(
            "trap '{trap_action}' TERM; sleep 30 & echo $! > \"{}\"; : > \"{}\"; while :; do sleep 0.02; done",
            descendant.display(),
            ready.display()
        );
        let pid = get_running_pid(vmo.start(build_shell_command(&script)).unwrap());
        wait_for_condition("the child has set its trap", || ready.exists());
        (pid, read_pid_file(&descendant))
    }

    /// Gets the pid of a running status.
    fn get_running_pid(status: VmoProcessStatus) -> u32 {
        match status {
            VmoProcessStatus::Running { pid } => pid,
            other => panic!("expected a running vmo, got {other:?}"),
        }
    }

    /// Waits at `barrier` for the other start, then starts a child that exits
    /// on `SIGTERM` and returns the pid of the child that runs.
    fn start_child_after_barrier(vmo: &Vmo, barrier: &Barrier) -> u32 {
        barrier.wait();
        get_running_pid(vmo.start(build_shell_command(EXITS_ON_SIGTERM)).unwrap())
    }

    #[test]
    fn ipc_answers_have_the_shapes_the_renderer_reads() {
        assert_eq!(
            to_value(VmoProcessStatus::Stopped).unwrap(),
            json!({ "status": "stopped" })
        );
        assert_eq!(
            to_value(VmoProcessStatus::Running { pid: 7 }).unwrap(),
            json!({ "status": "running", "pid": 7 })
        );
        assert_eq!(
            to_value(VmoProcessStatus::Stopping { pid: 7 }).unwrap(),
            json!({ "status": "stopping", "pid": 7 })
        );
        assert_eq!(
            to_value(VmoStopOutcome::Stopped).unwrap(),
            json!({ "status": "stopped" })
        );
        assert_eq!(
            to_value(VmoStopOutcome::Killed).unwrap(),
            json!({ "status": "killed" })
        );
        assert_eq!(to_value(VmoHealth::Ready).unwrap(), json!("ready"));
        assert_eq!(to_value(VmoHealth::NotReady).unwrap(), json!("not-ready"));
    }

    #[test]
    fn stop_without_a_child_reports_stopped() {
        let vmo = Vmo::new(SHORT_STOP_TIMEOUT);

        assert_eq!(vmo.stop(), Ok(VmoStopOutcome::Stopped));
        assert_eq!(vmo.status(), Ok(VmoProcessStatus::Stopped));
    }

    #[test]
    fn stop_ends_the_process_group_of_a_child_that_exits_on_sigterm() {
        let case = TestDirectory::create("vmo-sigterm");
        let (vmo, _stop) = create_guarded_vmo(LONG_STOP_TIMEOUT);
        let (_pid, descendant) = start_trapping_child(&vmo, &case, "exit 0");

        assert_eq!(vmo.stop(), Ok(VmoStopOutcome::Stopped));
        assert_eq!(vmo.status(), Ok(VmoProcessStatus::Stopped));
        wait_for_condition("the child's background sleep has exited", || {
            !is_process_alive(descendant)
        });
    }

    #[test]
    fn stop_kills_the_process_group_of_a_child_still_running_after_the_timeout() {
        let case = TestDirectory::create("vmo-kill");
        let (vmo, _stop) = create_guarded_vmo(SHORT_STOP_TIMEOUT);
        // The child and its background `sleep` ignore `SIGTERM`, so the whole
        // group outlives it and only `SIGKILL` ends it.
        let (_pid, descendant) = start_trapping_child(&vmo, &case, "");

        assert_eq!(vmo.stop(), Ok(VmoStopOutcome::Killed));
        assert_eq!(vmo.status(), Ok(VmoProcessStatus::Stopped));
        wait_for_condition("the child's background sleep has exited", || {
            !is_process_alive(descendant)
        });
    }

    #[test]
    fn a_child_that_exited_on_its_own_reads_and_stops_as_stopped() {
        let (vmo, _stop) = create_guarded_vmo(SHORT_STOP_TIMEOUT);
        get_running_pid(vmo.start(build_shell_command("exit 0")).unwrap());

        wait_for_condition("the child has exited", || {
            vmo.status() == Ok(VmoProcessStatus::Stopped)
        });

        assert_eq!(vmo.stop(), Ok(VmoStopOutcome::Stopped));
    }

    #[test]
    fn start_replaces_a_child_that_exited_on_its_own() {
        let case = TestDirectory::create("vmo-replace");
        let spawned = case.path().join("spawned");
        let (vmo, _stop) = create_guarded_vmo(LONG_STOP_TIMEOUT);
        let first = get_running_pid(vmo.start(build_shell_command("exit 0")).unwrap());
        wait_for_condition("the first child has exited", || {
            vmo.status() == Ok(VmoProcessStatus::Stopped)
        });
        let script = format!(": > \"{}\"; {EXITS_ON_SIGTERM}", spawned.display());

        let second = get_running_pid(vmo.start(build_shell_command(&script)).unwrap());

        assert_ne!(first, second);
        assert_eq!(vmo.status(), Ok(VmoProcessStatus::Running { pid: second }));
        wait_for_condition("the second child has run", || spawned.exists());
        assert_eq!(vmo.stop(), Ok(VmoStopOutcome::Stopped));
    }

    #[test]
    fn start_while_running_keeps_the_running_child() {
        let (vmo, _stop) = create_guarded_vmo(LONG_STOP_TIMEOUT);
        let pid = get_running_pid(vmo.start(build_shell_command(EXITS_ON_SIGTERM)).unwrap());

        let second = vmo.start(build_shell_command(EXITS_ON_SIGTERM));

        assert_eq!(second, Ok(VmoProcessStatus::Running { pid }));
        assert_eq!(vmo.status(), Ok(VmoProcessStatus::Running { pid }));
        assert_eq!(vmo.stop(), Ok(VmoStopOutcome::Stopped));
    }

    #[test]
    fn two_starts_released_together_spawn_one_child() {
        let (vmo, _stop) = create_guarded_vmo(LONG_STOP_TIMEOUT);
        // The barrier releases both starts together. The case asserts that
        // whichever start runs second gets the first one's child; it cannot
        // force both into the check and the spawn at once, which the owner's
        // lock makes one step.
        let barrier = Arc::new(Barrier::new(2));
        let other_start = {
            let (vmo, barrier) = (Arc::clone(&vmo), Arc::clone(&barrier));
            thread::spawn(move || start_child_after_barrier(&vmo, &barrier))
        };

        let pid = start_child_after_barrier(&vmo, &barrier);

        assert_eq!(other_start.join().unwrap(), pid);
        assert_eq!(vmo.status(), Ok(VmoProcessStatus::Running { pid }));
        assert_eq!(vmo.stop(), Ok(VmoStopOutcome::Stopped));
    }

    #[test]
    fn start_names_the_program_it_cannot_run() {
        let case = TestDirectory::create("vmo-missing");
        let missing = case.path().join("vmo");
        let (vmo, _stop) = create_guarded_vmo(SHORT_STOP_TIMEOUT);

        let start = vmo.start(Command::new(&missing));

        assert_eq!(
            start,
            Err(format!(
                "Failed to run {}: No such file or directory (os error 2)",
                missing.display()
            ))
        );
        assert_eq!(vmo.status(), Ok(VmoProcessStatus::Stopped));
    }

    #[test]
    fn start_after_a_stop_spawns_a_new_child() {
        let (vmo, _stop) = create_guarded_vmo(LONG_STOP_TIMEOUT);
        let first = get_running_pid(vmo.start(build_shell_command(EXITS_ON_SIGTERM)).unwrap());
        vmo.stop().unwrap();

        let second = get_running_pid(vmo.start(build_shell_command(EXITS_ON_SIGTERM)).unwrap());

        assert_ne!(first, second);
        assert_eq!(vmo.stop(), Ok(VmoStopOutcome::Stopped));
    }

    #[test]
    fn a_stop_in_progress_is_joined_without_a_second_sigterm() {
        let case = TestDirectory::create("vmo-join");
        let term_log = case.path().join("term.log");
        // The child logs SIGTERM and keeps running, so the first stop waits
        // the whole timeout and kills it; a joined stop shares that outcome.
        let (vmo, _stop) = create_guarded_vmo(JOINED_STOP_TIMEOUT);
        let (pid, _descendant) = start_trapping_child(
            &vmo,
            &case,
            &format!("echo term >> \"{}\"", term_log.display()),
        );
        let first_stop = {
            let vmo = Arc::clone(&vmo);
            thread::spawn(move || vmo.stop())
        };
        wait_for_condition("the child has logged SIGTERM", || {
            read_line_count(&term_log) == 1
        });
        assert_eq!(vmo.status(), Ok(VmoProcessStatus::Stopping { pid }));
        assert!(vmo.start(build_shell_command(EXITS_ON_SIGTERM)).is_err());

        // Joined on this thread right after `Stopping` was seen, so the join
        // reaches the owner a few statements later, far within the first
        // stop's timeout. Nothing outside `Vmo` can observe a joined stop, so
        // that margin is the one timing assumption left in this case.
        let joined_stop = vmo.stop();

        assert_eq!(joined_stop, Ok(VmoStopOutcome::Killed));
        assert_eq!(first_stop.join().unwrap(), Ok(VmoStopOutcome::Killed));
        assert_eq!(read_line_count(&term_log), 1);
        assert_eq!(vmo.status(), Ok(VmoProcessStatus::Stopped));
    }

    /// Starts a server on a free loopback port that accepts one connection,
    /// sends the request it reads to the returned channel, and answers with
    /// `answer`, or holds the connection open without answering when
    /// `answer` is `None`.
    fn start_health_server(
        answer: Option<&'static str>,
    ) -> (SocketAddr, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let address = listener.local_addr().expect("read the bound address");
        let (sender, receiver) = mpsc::channel();
        let server =
            thread::spawn(move || handle_health_check_connection(&listener, &sender, answer));
        (address, receiver, server)
    }

    /// Accepts one health check on `listener`, sends its request head to
    /// `sender`, and answers it with `answer`, or holds the connection open
    /// for 600 ms without answering when `answer` is `None`.
    fn handle_health_check_connection(
        listener: &TcpListener,
        sender: &mpsc::Sender<String>,
        answer: Option<&'static str>,
    ) {
        let (mut stream, _) = listener.accept().expect("accept the health check");
        let request = read_request_head(&mut stream);
        sender.send(request).expect("report the request");
        match answer {
            Some(answer) => stream.write_all(answer.as_bytes()).expect("answer"),
            None => thread::sleep(Duration::from_millis(600)),
        }
    }

    /// Reads a request head, up to the blank line that ends it.
    fn read_request_head(stream: &mut TcpStream) -> String {
        let mut head = Vec::new();
        let mut byte = [0_u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).expect("read the request") == 0 {
                break;
            }
            head.push(byte[0]);
        }
        String::from_utf8(head).expect("an ASCII request head")
    }

    #[test]
    fn health_is_ready_when_vmo_answers_200() {
        let (address, request, server) =
            start_health_server(Some("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok\n"));

        let health = send_vmo_health_check(address, Duration::from_secs(1));

        assert_eq!(health, VmoHealth::Ready);
        let request = request.recv().unwrap();
        assert!(request.starts_with("GET /health HTTP/1.1\r\n"), "{request}");
        assert!(request.contains("\r\nConnection: close\r\n"), "{request}");
        server.join().unwrap();
    }

    #[test]
    fn health_is_not_ready_for_another_status() {
        let (address, _request, server) = start_health_server(Some(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
        ));

        assert_eq!(
            send_vmo_health_check(address, Duration::from_secs(1)),
            VmoHealth::NotReady
        );
        server.join().unwrap();
    }

    #[test]
    fn health_is_not_ready_when_nothing_listens() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);

        assert_eq!(
            send_vmo_health_check(address, Duration::from_secs(1)),
            VmoHealth::NotReady
        );
    }

    #[test]
    fn health_is_not_ready_when_vmo_does_not_answer_in_time() {
        let (address, _request, server) = start_health_server(None);

        let started = Instant::now();
        let health = send_vmo_health_check(address, Duration::from_millis(200));

        assert_eq!(health, VmoHealth::NotReady);
        assert!(started.elapsed() < Duration::from_millis(550));
        server.join().unwrap();
    }
}
