//! Ownership and Tauri commands for voice, Lys's speech server.
//!
//! voice speaks Lys's replies aloud with PocketTTS on the machine. The
//! desktop owns at most one voice child, as it owns the backend and vmo.
//! Development builds run `apps/voice/run.sh`, which builds voice and then
//! becomes it; release builds run the binary that `build.sh` installs under
//! the Lys home. The child runs in its own Unix process group.
//!
//! A stop sends `SIGTERM` once and waits up to [`VOICE_STOP_TIMEOUT`] for
//! voice to exit before it sends `SIGKILL` to its group. A stop already in
//! progress is joined rather than repeated. The health check asks voice's
//! `GET /health` route from here because voice answers only once its models
//! are loaded and sends no CORS headers the renderer could read an answer
//! through.

use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
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

/// Longest time a stop waits for voice to exit after `SIGTERM` before it sends
/// `SIGKILL`: long enough for voice to close its sockets and free its models.
pub const VOICE_STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// How often a stop checks whether voice has exited.
const VOICE_EXIT_CHECK_INTERVAL: Duration = Duration::from_millis(100);

/// Time limit of each health check, from connecting to reading the status line.
const VOICE_HEALTH_TIMEOUT: Duration = Duration::from_secs(1);

/// Most bytes of voice's answer a health check reads while looking for the
/// end of its status line.
const MAX_VOICE_STATUS_LINE_BYTES: usize = 64;

/// Status line that starts every answer meaning voice can speak.
const VOICE_HEALTHY_STATUS_LINE_PREFIX: &[u8] = b"HTTP/1.1 200 ";

/// Loopback address on which voice listens.
///
/// It must equal `VOICE_HOST` and `VOICE_PORT` in
/// `packages/protocol/src/constant.ts`, which the backend and the renderer
/// use, and the default host and port of voice's web server in
/// `apps/voice`. This copy is kept under the approved voice address copy
/// exception to CONST-005, like vmo's: the renderer cannot check it without a
/// round trip, and a unit test fails when the three differ.
const VOICE_ADDRESS: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 9090);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
/// Lifecycle stage of the voice child the desktop owns, as the renderer
/// receives it: `{ "status": "stopped" }`, or `running` and `stopping` with a
/// `pid`.
pub enum VoiceProcessStatus {
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
/// How a stop ended voice, as the renderer receives it: `{ "status":
/// "stopped" }` or `{ "status": "killed" }`.
pub enum VoiceStopOutcome {
    /// voice exited within the stop timeout, or no running child was owned.
    Stopped,
    /// voice still ran when the stop timeout passed and was killed with
    /// `SIGKILL`.
    Killed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
/// Whether voice answered its health route, as the renderer receives it:
/// `"ready"` or `"not-ready"`.
pub enum VoiceHealth {
    /// voice answered `GET /health` with `200 OK`, so its models are loaded.
    Ready,
    /// Nothing answered within the time limit, or the answer was not `200 OK`.
    NotReady,
}

/// Result of one stop, shared by its caller and every stop that joined it.
type VoiceStopResult = Result<VoiceStopOutcome, String>;

/// Where one stop publishes its result, once, for every stop that joined it.
///
/// Only the stop that took the child sets it; a joined stop blocks in
/// [`OnceLock::wait`] until then and returns a copy.
type VoiceStopSettlement = OnceLock<VoiceStopResult>;

/// The voice child the desktop owns, by lifecycle stage.
enum VoiceProcess {
    /// No child is owned.
    Stopped,
    /// A spawned child no stop has taken; it may have exited on its own.
    Running(Child),
    /// A stop took the child, sent it `SIGTERM`, and waits for it to exit.
    Stopping {
        /// Operating-system process identifier of the child.
        pid: u32,
        /// Where that stop publishes its result for the stops that join it.
        settlement: Arc<VoiceStopSettlement>,
    },
}

/// What a stop found when it took the lock.
enum VoiceStopAdmission {
    /// No running child is owned, so the stop has nothing to do.
    NothingRunning,
    /// Another stop is waiting for the child; this stop shares its result.
    Joined(Arc<VoiceStopSettlement>),
    /// This stop took the running child and publishes the result.
    Admitted {
        /// The child to stop, now owned by the stop.
        child: Child,
        /// Where the result is published for the stops that join this one.
        settlement: Arc<VoiceStopSettlement>,
    },
}

/// Owns the voice child process to start, stop, and report voice while
/// keeping two rules: at most one child is owned, and a child receives
/// `SIGTERM` at most once.
///
/// The state is one [`VoiceProcess`] behind a mutex, and every operation
/// reads or changes it within one lock. A stop releases the lock while it
/// waits for voice to exit, so a status read or another stop never waits
/// behind that wait. Concurrency model: concurrent. `start`, `status`, and
/// the admission of a stop are serialized by the lock; the waits of stops
/// overlap them. The owned child is released only by [`Voice::stop`]:
/// dropping a `Voice` leaves the child running, so the application stops it
/// when it exits. A poisoned lock is recovered, because every change of the
/// state is one assignment.
pub struct Voice {
    /// Owned child, by lifecycle stage.
    process: Mutex<VoiceProcess>,
    /// Longest time a stop waits after `SIGTERM` before it sends `SIGKILL`.
    stop_timeout: Duration,
}

impl Voice {
    /// Creates an owner that owns no child, without starting anything.
    ///
    /// `stop_timeout` is the longest time a stop waits for voice to exit
    /// after `SIGTERM`; the application passes [`VOICE_STOP_TIMEOUT`].
    pub fn new(stop_timeout: Duration) -> Self {
        Self {
            process: Mutex::new(VoiceProcess::Stopped),
            stop_timeout,
        }
    }

    /// Starts `command` as the voice child unless a child already runs.
    ///
    /// A running child is left alone and its status returned. Otherwise
    /// `command` is spawned in a new process group of its own and stored,
    /// replacing an exited child. The check and the spawn share one lock, so
    /// two starts never spawn two children.
    ///
    /// # Errors
    ///
    /// Returns an error while a stop is waiting for the previous child, which
    /// still holds voice's port, when the owned child cannot be inspected, or
    /// when `command` cannot be spawned; that error names the program, so a
    /// missing install shows where voice was expected.
    pub fn start(&self, mut command: Command) -> Result<VoiceProcessStatus, String> {
        let mut process = self.get_locked_process();
        match &mut *process {
            VoiceProcess::Stopping { .. } => {
                return Err(String::from(
                    "voice is still stopping; start it again once it has stopped",
                ));
            }
            VoiceProcess::Running(child) => {
                if let Some(pid) = find_running_voice_pid(child)? {
                    return Ok(VoiceProcessStatus::Running { pid });
                }
            }
            VoiceProcess::Stopped => {}
        }

        let child = command.process_group(0).spawn().map_err(|err| {
            format!(
                "Failed to run {}: {err}",
                Path::new(command.get_program()).display()
            )
        })?;
        let pid = child.id();
        *process = VoiceProcess::Running(child);
        Ok(VoiceProcessStatus::Running { pid })
    }

    /// Reports the owned child's lifecycle stage without blocking.
    ///
    /// An exited child is reported as stopped and stays stored until a start
    /// replaces it or a stop removes it.
    ///
    /// # Errors
    ///
    /// Returns an error when the operating system cannot inspect the child.
    pub fn status(&self) -> Result<VoiceProcessStatus, String> {
        let mut process = self.get_locked_process();
        match &mut *process {
            VoiceProcess::Stopped => Ok(VoiceProcessStatus::Stopped),
            VoiceProcess::Running(child) => Ok(find_running_voice_pid(child)?
                .map_or(VoiceProcessStatus::Stopped, |pid| {
                    VoiceProcessStatus::Running { pid }
                })),
            VoiceProcess::Stopping { pid, .. } => Ok(VoiceProcessStatus::Stopping { pid: *pid }),
        }
    }

    /// Stops the owned child and waits until it has exited.
    ///
    /// Without a running child it returns `Stopped` at once and forgets an
    /// exited child. Otherwise it sends `SIGTERM` to the child's process
    /// group, waits up to the stop timeout for the child to exit, and then
    /// sends `SIGKILL` to the group and waits again. The wait happens
    /// without the lock, which reports `stopping` meanwhile. A stop called
    /// during that wait sends nothing and returns the same result once the
    /// first settles. The call blocks for up to the stop timeout, so callers
    /// keep it off the main thread except during application exit.
    ///
    /// # Errors
    ///
    /// Returns an error when the child cannot be inspected before the stop
    /// takes it; the child then stays owned as it was. Once the stop has taken
    /// the child, it returns an error when the child cannot be signalled,
    /// inspected, or waited for: after a failed `SIGTERM` or check, the group
    /// is sent `SIGKILL` once and the child waited for, a failed `SIGKILL` or
    /// wait is not repeated, and the owner holds no child afterwards.
    pub fn stop(&self) -> VoiceStopResult {
        let (child, settlement) = match self.update_process_for_stop()? {
            VoiceStopAdmission::NothingRunning => return Ok(VoiceStopOutcome::Stopped),
            VoiceStopAdmission::Joined(settlement) => return settlement.wait().clone(),
            VoiceStopAdmission::Admitted { child, settlement } => (child, settlement),
        };

        let result = stop_voice_child(child, self.stop_timeout);
        // Leave `Stopping` before publishing, so a caller woken by the result
        // can start voice again at once.
        *self.get_locked_process() = VoiceProcess::Stopped;
        settlement
            .set(result.clone())
            .expect("only the stop that took the child publishes its result");
        result
    }

    /// Gets the owned child's state under its lock, recovering a poisoned
    /// lock.
    fn get_locked_process(&self) -> MutexGuard<'_, VoiceProcess> {
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
    fn update_process_for_stop(&self) -> Result<VoiceStopAdmission, String> {
        let mut process = self.get_locked_process();
        match std::mem::replace(&mut *process, VoiceProcess::Stopped) {
            VoiceProcess::Stopped => Ok(VoiceStopAdmission::NothingRunning),
            VoiceProcess::Stopping { pid, settlement } => {
                let joined = Arc::clone(&settlement);
                *process = VoiceProcess::Stopping { pid, settlement };
                Ok(VoiceStopAdmission::Joined(joined))
            }
            VoiceProcess::Running(mut child) => match child.try_wait() {
                Ok(Some(_exit_status)) => Ok(VoiceStopAdmission::NothingRunning),
                Ok(None) => {
                    let settlement = Arc::new(VoiceStopSettlement::new());
                    *process = VoiceProcess::Stopping {
                        pid: child.id(),
                        settlement: Arc::clone(&settlement),
                    };
                    Ok(VoiceStopAdmission::Admitted { child, settlement })
                }
                Err(err) => {
                    *process = VoiceProcess::Running(child);
                    Err(format!("Failed to inspect voice process: {err}"))
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
fn find_running_voice_pid(child: &mut Child) -> Result<Option<u32>, String> {
    match child.try_wait() {
        Ok(None) => Ok(Some(child.id())),
        Ok(Some(_exit_status)) => Ok(None),
        Err(err) => Err(format!("Failed to inspect voice process: {err}")),
    }
}

/// Stops one voice child: `SIGTERM` to its process group, up to `stop_timeout`
/// for it to exit, and `SIGKILL` to the group with a wait for the child when
/// it still runs then.
///
/// `SIGKILL` is sent at most once: after the timeout, or after `SIGTERM` or a
/// check failed. A failed `SIGKILL` or wait is not repeated, because the
/// group's identifier may already name another group by then.
///
/// # Errors
///
/// Returns an error when the group cannot be signalled for a reason other
/// than being gone, or the child cannot be inspected or waited for. After a
/// failed `SIGTERM` or check, the group is sent `SIGKILL` and the child waited
/// for, and a failure of that is added to the error.
fn stop_voice_child(mut child: Child, stop_timeout: Duration) -> VoiceStopResult {
    let pid = child.id();
    let has_exited = send_voice_signal(pid, Signal::SIGTERM)
        .and_then(|()| wait_for_voice_exit(&mut child, stop_timeout));
    let outcome = match has_exited {
        Ok(true) => Ok(VoiceStopOutcome::Stopped),
        Ok(false) => send_sigkill_and_wait_for_voice(&mut child).map(|()| VoiceStopOutcome::Killed),
        Err(error) => Err(format_voice_stop_failure(
            error,
            send_sigkill_and_wait_for_voice(&mut child),
        )),
    };
    outcome.map_err(|error| format!("Failed to stop voice process {pid}: {error}"))
}

/// Formats the failure of a stop that ended before its `SIGKILL`, adding the
/// failure of the `SIGKILL` sent after it when that failed too.
fn format_voice_stop_failure(error: String, kill: Result<(), String>) -> String {
    match kill {
        Ok(()) => error,
        Err(kill_error) => format!("{error}; {kill_error}"),
    }
}

/// Sends `SIGKILL` to the child's process group and waits for the child.
///
/// # Errors
///
/// Returns an error when signalling or waiting fails.
fn send_sigkill_and_wait_for_voice(child: &mut Child) -> Result<(), String> {
    send_voice_signal(child.id(), Signal::SIGKILL)?;
    child
        .wait()
        .map(|_exit_status| ())
        .map_err(|err| format!("failed to wait for it: {err}"))
}

/// Sends `signal` to the Unix process group whose identifier is `pid`.
///
/// The child was spawned as the leader of that group, so the signal reaches
/// voice and, in development, the build `run.sh` runs before it becomes
/// voice. A group that is already gone counts as signalled.
///
/// # Errors
///
/// Returns an error when `pid` is outside the range of a Unix process
/// identifier or Unix refuses the signal for a reason other than `ESRCH`.
fn send_voice_signal(pid: u32, signal: Signal) -> Result<(), String> {
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
/// [`VOICE_EXIT_CHECK_INTERVAL`].
///
/// Returns whether the child exited.
///
/// # Errors
///
/// Returns an error when the operating system cannot inspect the child.
fn wait_for_voice_exit(child: &mut Child, timeout: Duration) -> Result<bool, String> {
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
        thread::sleep(VOICE_EXIT_CHECK_INTERVAL.min(deadline - now));
    }
}

/// Sends one `GET /health` request to voice at `address` and reports whether
/// it answered `200 OK`.
///
/// Connecting, sending, and reading the status line all happen within
/// `timeout`. Only the status line is read; a refused connection, a timeout,
/// or any other status means voice is not ready.
fn send_voice_health_check(address: SocketAddr, timeout: Duration) -> VoiceHealth {
    match send_voice_health_request(address, timeout) {
        Ok(status_line) if status_line.starts_with(VOICE_HEALTHY_STATUS_LINE_PREFIX) => {
            VoiceHealth::Ready
        }
        Ok(_) | Err(_) => VoiceHealth::NotReady,
    }
}

/// Sends `GET /health` to `address` and returns the answer's status line.
///
/// Returns at most [`MAX_VOICE_STATUS_LINE_BYTES`] bytes, ending with `\r\n`
/// unless the answer ended or the limit was reached first.
///
/// # Errors
///
/// Returns the I/O error of connecting, sending, or reading, including a
/// timeout once `timeout` has passed since the call began.
fn send_voice_health_request(address: SocketAddr, timeout: Duration) -> std::io::Result<Vec<u8>> {
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect_timeout(&address, timeout)?;
    stream.set_write_timeout(Some(find_remaining_time(deadline)?))?;
    stream.write_all(
        format!("GET /health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").as_bytes(),
    )?;

    let mut status_line = Vec::with_capacity(MAX_VOICE_STATUS_LINE_BYTES);
    let mut buffer = [0_u8; MAX_VOICE_STATUS_LINE_BYTES];
    while status_line.len() < MAX_VOICE_STATUS_LINE_BYTES && !status_line.ends_with(b"\r\n") {
        stream.set_read_timeout(Some(find_remaining_time(deadline)?))?;
        let wanted = MAX_VOICE_STATUS_LINE_BYTES - status_line.len();
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
            "the voice health check ran out of time",
        ));
    }
    Ok(remaining)
}

/// Resolves the repository's voice package directory from the Tauri crate
/// location: `apps/voice`, beside `apps/desktop`.
///
/// # Errors
///
/// Returns an error if the manifest path does not have the expected parents.
fn get_voice_dir() -> Result<PathBuf, String> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| String::from("Failed to resolve apps directory"))?
        .join("voice"))
}

/// Builds the command that runs voice for the current build mode.
///
/// Development builds run `bash run.sh` in `apps/voice`, which builds voice
/// and then becomes it. Release builds run the voice binary that `build.sh`
/// installs under `lys_home`. Neither reads `LYS_HOME`.
///
/// # Errors
///
/// Returns an error when the development voice directory cannot be resolved.
fn build_voice_command(lys_home: &LysHome) -> Result<Command, String> {
    if tauri::is_dev() {
        let mut command = Command::new("bash");
        command.arg("run.sh").current_dir(get_voice_dir()?);
        Ok(command)
    } else {
        Ok(Command::new(lys_home.voice_executable_path()))
    }
}

#[tauri::command]
/// Starts voice unless the desktop already owns a running voice.
///
/// A running child is left alone and its status returned; otherwise voice for
/// the current build mode is spawned in its own process group. Spawning
/// returns at once: voice first loads its models, which can take a while on
/// the first start, and answers `get_voice_health` only after that.
///
/// # Errors
///
/// Returns an error while a stop is still waiting for the previous voice, or
/// when the development directory cannot be resolved, the child cannot be
/// inspected, or voice cannot be spawned, for example because `build.sh` has
/// not installed it.
pub fn start_voice(
    voice: State<'_, Voice>,
    lys_home: State<'_, LysHome>,
) -> Result<VoiceProcessStatus, String> {
    voice.start(build_voice_command(&lys_home)?)
}

#[tauri::command]
/// Reads the lifecycle stage of the voice the desktop owns, without blocking.
///
/// # Errors
///
/// Returns an error when the child cannot be inspected.
pub fn get_voice_status(voice: State<'_, Voice>) -> Result<VoiceProcessStatus, String> {
    voice.status()
}

#[tauri::command]
/// Stops the voice the desktop owns, waiting until it has exited.
///
/// voice gets `SIGTERM` once and up to five seconds to exit before it is
/// killed, which the outcome reports as `killed`. The wait runs on Tauri's
/// blocking-task pool, so the window stays responsive; it cannot be
/// cancelled. A stop called while another waits joins it.
///
/// # Errors
///
/// Returns an error when the child cannot be inspected, signalled, or waited
/// for, or when the blocking task ends unexpectedly.
pub async fn stop_voice(app: AppHandle) -> VoiceStopResult {
    tauri::async_runtime::spawn_blocking(move || app.state::<Voice>().stop())
        .await
        .map_err(|err| format!("The voice stop ended unexpectedly: {err}"))?
}

#[tauri::command]
/// Asks voice's `GET /health` route on `127.0.0.1:9090` whether voice can
/// speak.
///
/// The check takes at most about one second and runs on Tauri's
/// blocking-task pool. It asks whichever process listens on voice's port,
/// also a voice the desktop does not own.
///
/// # Errors
///
/// Returns an error only when the blocking task ends unexpectedly.
pub async fn get_voice_health() -> Result<VoiceHealth, String> {
    tauri::async_runtime::spawn_blocking(|| {
        send_voice_health_check(SocketAddr::V4(VOICE_ADDRESS), VOICE_HEALTH_TIMEOUT)
    })
    .await
    .map_err(|err| format!("The voice health check ended unexpectedly: {err}"))
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

    use super::{
        format_voice_stop_failure, send_voice_health_check, Voice, VoiceHealth, VoiceProcessStatus,
        VoiceStopOutcome,
    };
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

    /// Stops the case's voice child when dropped, so that a failed assertion or
    /// setup step leaves no shell running after the test.
    ///
    /// A stop failure fails the test unless the test is already failing, so
    /// that the original failure stays the reported one.
    struct VoiceStopGuard(Arc<Voice>);

    impl Drop for VoiceStopGuard {
        /// Stops the case's voice child and waits until it has exited.
        fn drop(&mut self) {
            if let Err(error) = self.0.stop() {
                assert!(thread::panicking(), "stop the case's voice child: {error}");
            }
        }
    }

    /// Creates an owner with `stop_timeout` together with the guard that stops
    /// its child when the case ends, before the case starts anything.
    fn create_guarded_voice(stop_timeout: Duration) -> (Arc<Voice>, VoiceStopGuard) {
        let voice = Arc::new(Voice::new(stop_timeout));
        let guard = VoiceStopGuard(Arc::clone(&voice));
        (voice, guard)
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
    fn start_trapping_child(voice: &Voice, case: &TestDirectory, trap_action: &str) -> (u32, i32) {
        let ready = case.path().join("ready");
        let descendant = case.path().join("descendant.pid");
        let script = format!(
            "trap '{trap_action}' TERM; sleep 30 & echo $! > \"{}\"; : > \"{}\"; while :; do sleep 0.02; done",
            descendant.display(),
            ready.display()
        );
        let pid = get_running_pid(voice.start(build_shell_command(&script)).unwrap());
        wait_for_condition("the child has set its trap", || ready.exists());
        (pid, read_pid_file(&descendant))
    }

    /// Gets the pid of a running status.
    fn get_running_pid(status: VoiceProcessStatus) -> u32 {
        match status {
            VoiceProcessStatus::Running { pid } => pid,
            other => panic!("expected a running voice, got {other:?}"),
        }
    }

    /// Waits at `barrier` for the other start, then starts a child that exits
    /// on `SIGTERM` and returns the pid of the child that runs.
    fn start_child_after_barrier(voice: &Voice, barrier: &Barrier) -> u32 {
        barrier.wait();
        get_running_pid(voice.start(build_shell_command(EXITS_ON_SIGTERM)).unwrap())
    }

    #[test]
    fn ipc_answers_have_the_shapes_the_renderer_reads() {
        assert_eq!(
            to_value(VoiceProcessStatus::Stopped).unwrap(),
            json!({ "status": "stopped" })
        );
        assert_eq!(
            to_value(VoiceProcessStatus::Running { pid: 7 }).unwrap(),
            json!({ "status": "running", "pid": 7 })
        );
        assert_eq!(
            to_value(VoiceProcessStatus::Stopping { pid: 7 }).unwrap(),
            json!({ "status": "stopping", "pid": 7 })
        );
        assert_eq!(
            to_value(VoiceStopOutcome::Stopped).unwrap(),
            json!({ "status": "stopped" })
        );
        assert_eq!(
            to_value(VoiceStopOutcome::Killed).unwrap(),
            json!({ "status": "killed" })
        );
        assert_eq!(to_value(VoiceHealth::Ready).unwrap(), json!("ready"));
        assert_eq!(to_value(VoiceHealth::NotReady).unwrap(), json!("not-ready"));
    }

    #[test]
    fn a_failure_before_sigkill_is_kept_and_a_failed_sigkill_is_added() {
        let error = String::from("failed to inspect it: Interrupted system call (os error 4)");

        assert_eq!(format_voice_stop_failure(error.clone(), Ok(())), error);
        assert_eq!(
            format_voice_stop_failure(
                error.clone(),
                Err(String::from(
                    "failed to wait for it: No child processes (os error 10)"
                ))
            ),
            format!("{error}; failed to wait for it: No child processes (os error 10)")
        );
    }

    #[test]
    fn stop_without_a_child_reports_stopped() {
        let voice = Voice::new(SHORT_STOP_TIMEOUT);

        assert_eq!(voice.stop(), Ok(VoiceStopOutcome::Stopped));
        assert_eq!(voice.status(), Ok(VoiceProcessStatus::Stopped));
    }

    #[test]
    fn stop_ends_the_process_group_of_a_child_that_exits_on_sigterm() {
        let case = TestDirectory::create("voice-sigterm");
        let (voice, _stop) = create_guarded_voice(LONG_STOP_TIMEOUT);
        let (_pid, descendant) = start_trapping_child(&voice, &case, "exit 0");

        assert_eq!(voice.stop(), Ok(VoiceStopOutcome::Stopped));
        assert_eq!(voice.status(), Ok(VoiceProcessStatus::Stopped));
        wait_for_condition("the child's background sleep has exited", || {
            !is_process_alive(descendant)
        });
    }

    #[test]
    fn stop_kills_the_process_group_of_a_child_still_running_after_the_timeout() {
        let case = TestDirectory::create("voice-kill");
        let (voice, _stop) = create_guarded_voice(SHORT_STOP_TIMEOUT);
        // The child and its background `sleep` ignore `SIGTERM`, so the whole
        // group outlives it and only `SIGKILL` ends it.
        let (_pid, descendant) = start_trapping_child(&voice, &case, "");

        assert_eq!(voice.stop(), Ok(VoiceStopOutcome::Killed));
        assert_eq!(voice.status(), Ok(VoiceProcessStatus::Stopped));
        wait_for_condition("the child's background sleep has exited", || {
            !is_process_alive(descendant)
        });
    }

    #[test]
    fn a_child_that_exited_on_its_own_reads_and_stops_as_stopped() {
        let (voice, _stop) = create_guarded_voice(SHORT_STOP_TIMEOUT);
        get_running_pid(voice.start(build_shell_command("exit 0")).unwrap());

        wait_for_condition("the child has exited", || {
            voice.status() == Ok(VoiceProcessStatus::Stopped)
        });

        assert_eq!(voice.stop(), Ok(VoiceStopOutcome::Stopped));
    }

    #[test]
    fn start_replaces_a_child_that_exited_on_its_own() {
        let case = TestDirectory::create("voice-replace");
        let spawned = case.path().join("spawned");
        let (voice, _stop) = create_guarded_voice(LONG_STOP_TIMEOUT);
        let first = get_running_pid(voice.start(build_shell_command("exit 0")).unwrap());
        wait_for_condition("the first child has exited", || {
            voice.status() == Ok(VoiceProcessStatus::Stopped)
        });
        let script = format!(": > \"{}\"; {EXITS_ON_SIGTERM}", spawned.display());

        let second = get_running_pid(voice.start(build_shell_command(&script)).unwrap());

        assert_ne!(first, second);
        assert_eq!(
            voice.status(),
            Ok(VoiceProcessStatus::Running { pid: second })
        );
        wait_for_condition("the second child has run", || spawned.exists());
        assert_eq!(voice.stop(), Ok(VoiceStopOutcome::Stopped));
    }

    #[test]
    fn start_while_running_keeps_the_running_child() {
        let (voice, _stop) = create_guarded_voice(LONG_STOP_TIMEOUT);
        let pid = get_running_pid(voice.start(build_shell_command(EXITS_ON_SIGTERM)).unwrap());

        let second = voice.start(build_shell_command(EXITS_ON_SIGTERM));

        assert_eq!(second, Ok(VoiceProcessStatus::Running { pid }));
        assert_eq!(voice.status(), Ok(VoiceProcessStatus::Running { pid }));
        assert_eq!(voice.stop(), Ok(VoiceStopOutcome::Stopped));
    }

    #[test]
    fn two_starts_released_together_spawn_one_child() {
        let (voice, _stop) = create_guarded_voice(LONG_STOP_TIMEOUT);
        // The barrier releases both starts together. The case asserts that
        // whichever start runs second gets the first one's child; it cannot
        // force both into the check and the spawn at once, which the owner's
        // lock makes one step.
        let barrier = Arc::new(Barrier::new(2));
        let other_start = {
            let (voice, barrier) = (Arc::clone(&voice), Arc::clone(&barrier));
            thread::spawn(move || start_child_after_barrier(&voice, &barrier))
        };

        let pid = start_child_after_barrier(&voice, &barrier);

        assert_eq!(other_start.join().unwrap(), pid);
        assert_eq!(voice.status(), Ok(VoiceProcessStatus::Running { pid }));
        assert_eq!(voice.stop(), Ok(VoiceStopOutcome::Stopped));
    }

    #[test]
    fn start_names_the_program_it_cannot_run() {
        let case = TestDirectory::create("voice-missing");
        let missing = case.path().join("voice");
        let (voice, _stop) = create_guarded_voice(SHORT_STOP_TIMEOUT);

        let start = voice.start(Command::new(&missing));

        assert_eq!(
            start,
            Err(format!(
                "Failed to run {}: No such file or directory (os error 2)",
                missing.display()
            ))
        );
        assert_eq!(voice.status(), Ok(VoiceProcessStatus::Stopped));
    }

    #[test]
    fn start_after_a_stop_spawns_a_new_child() {
        let (voice, _stop) = create_guarded_voice(LONG_STOP_TIMEOUT);
        let first = get_running_pid(voice.start(build_shell_command(EXITS_ON_SIGTERM)).unwrap());
        voice.stop().unwrap();

        let second = get_running_pid(voice.start(build_shell_command(EXITS_ON_SIGTERM)).unwrap());

        assert_ne!(first, second);
        assert_eq!(voice.stop(), Ok(VoiceStopOutcome::Stopped));
    }

    #[test]
    fn a_stop_in_progress_is_joined_without_a_second_sigterm() {
        let case = TestDirectory::create("voice-join");
        let term_log = case.path().join("term.log");
        // The child logs SIGTERM and keeps running, so the first stop waits
        // the whole timeout and kills it; a joined stop shares that outcome.
        let (voice, _stop) = create_guarded_voice(JOINED_STOP_TIMEOUT);
        let (pid, _descendant) = start_trapping_child(
            &voice,
            &case,
            &format!("echo term >> \"{}\"", term_log.display()),
        );
        let first_stop = {
            let voice = Arc::clone(&voice);
            thread::spawn(move || voice.stop())
        };
        wait_for_condition("the child has logged SIGTERM", || {
            read_line_count(&term_log) == 1
        });
        assert_eq!(voice.status(), Ok(VoiceProcessStatus::Stopping { pid }));
        assert!(voice.start(build_shell_command(EXITS_ON_SIGTERM)).is_err());

        // Joined on this thread right after `Stopping` was seen, so the join
        // reaches the owner a few statements later, far within the first
        // stop's timeout. Nothing outside `Voice` can observe a joined stop, so
        // that margin is the one timing assumption left in this case.
        let joined_stop = voice.stop();

        assert_eq!(joined_stop, Ok(VoiceStopOutcome::Killed));
        assert_eq!(first_stop.join().unwrap(), Ok(VoiceStopOutcome::Killed));
        assert_eq!(read_line_count(&term_log), 1);
        assert_eq!(voice.status(), Ok(VoiceProcessStatus::Stopped));
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
    fn health_is_ready_when_voice_answers_200() {
        let (address, request, server) =
            start_health_server(Some("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok\n"));

        let health = send_voice_health_check(address, Duration::from_secs(1));

        assert_eq!(health, VoiceHealth::Ready);
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
            send_voice_health_check(address, Duration::from_secs(1)),
            VoiceHealth::NotReady
        );
        server.join().unwrap();
    }

    #[test]
    fn health_is_not_ready_when_nothing_listens() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);

        assert_eq!(
            send_voice_health_check(address, Duration::from_secs(1)),
            VoiceHealth::NotReady
        );
    }

    #[test]
    fn health_is_not_ready_when_voice_does_not_answer_in_time() {
        let (address, _request, server) = start_health_server(None);

        let started = Instant::now();
        let health = send_voice_health_check(address, Duration::from_millis(200));

        assert_eq!(health, VoiceHealth::NotReady);
        assert!(started.elapsed() < Duration::from_millis(550));
        server.join().unwrap();
    }
}
