use std::{
    io,
    mem::MaybeUninit,
    process::Child,
    thread,
    time::{Duration, Instant},
};

const NO_SIGNAL: i32 = 0;
const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;
const EPERM: i32 = 1;
const ESRCH: i32 = 3;
const GRACE_PERIOD: Duration = Duration::from_secs(2);
const FORCE_KILL_PERIOD: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SignalOutcome {
    Succeeded,
    GroupMissing,
    PermissionDenied,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminationOutcome {
    Complete,
    GroupMissing,
}

impl SignalOutcome {
    fn group_exists(self) -> bool {
        self != Self::GroupMissing
    }
}

unsafe extern "C" {
    #[link_name = "kill"]
    fn posix_kill(pid: i32, signal: i32) -> i32;
}

#[cfg(test)]
unsafe extern "C" {
    #[link_name = "waitpid"]
    fn posix_waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}

fn group_id(process_group_id: u32) -> io::Result<i32> {
    i32::try_from(process_group_id).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "backend process-group ID {process_group_id} does not fit \
                 in a POSIX process ID"
            ),
        )
    })
}

fn classify_signal_result(result: i32, error: io::Error) -> io::Result<SignalOutcome> {
    if result == 0 {
        return Ok(SignalOutcome::Succeeded);
    }

    match error.raw_os_error() {
        Some(ESRCH) => Ok(SignalOutcome::GroupMissing),
        Some(EPERM) => Ok(SignalOutcome::PermissionDenied),
        _ => Err(error),
    }
}

fn signal_group(group_id: i32, signal: i32) -> io::Result<SignalOutcome> {
    // SAFETY: `group_id` is a validated positive process ID. Negating it asks
    // POSIX `kill` to target that process group; `signal` is one of 0, 9, or 15.
    let result = unsafe { posix_kill(-group_id, signal) };
    let error = io::Error::last_os_error();
    classify_signal_result(result, error).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "failed to send signal {signal} to backend process group \
                 {group_id}: {error}"
            ),
        )
    })
}

fn group_is_running(group_id: i32) -> io::Result<bool> {
    // Darwin excludes zombies from kill(2) group lookup. With the direct
    // leader intentionally unreaped, ESRCH therefore means no live member of
    // the backend group remains; a live descendant keeps the lookup present.
    Ok(signal_group(group_id, NO_SIGNAL)?.group_exists())
}

pub(super) fn leader_has_exited(child: &Child) -> io::Result<bool> {
    let pid = group_id(child.id())?;
    let mut info = MaybeUninit::<libc::siginfo_t>::zeroed();

    // SAFETY: `pid` identifies a child owned by this process, `info` points to
    // writable zeroed storage, and WNOWAIT keeps the child waitable so its PID
    // continues to pin the process-group identity until the final signal.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == -1 {
        let error = io::Error::last_os_error();
        return Err(io::Error::new(
            error.kind(),
            format!(
                "failed to inspect backend process-group leader {pid} \
                 without reaping it: {error}"
            ),
        ));
    }

    // SAFETY: the storage was zero-initialized before `waitid`; on success,
    // `waitid` either writes a child status or leaves `si_pid` as zero when
    // WNOHANG finds no matching state change.
    let info = unsafe { info.assume_init() };
    Ok(unsafe { info.si_pid() } != 0)
}

fn wait_for_group_exit(group_id: i32, timeout: Duration) -> io::Result<bool> {
    wait_for_group_exit_with(timeout, || group_is_running(group_id))
}

fn wait_for_group_exit_with<F>(
    timeout: Duration,
    mut inspect_group: F,
) -> io::Result<bool>
where
    F: FnMut() -> io::Result<bool>,
{
    let deadline = Instant::now() + timeout;

    loop {
        if !inspect_group()? {
            return Ok(true);
        }

        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }

        thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

fn terminate_group_with<S, W>(
    group_id: i32,
    mut signal: S,
    mut wait_for_group_exit: W,
) -> io::Result<TerminationOutcome>
where
    S: FnMut(i32, i32) -> io::Result<SignalOutcome>,
    W: FnMut(Duration) -> io::Result<bool>,
{
    if signal(group_id, SIGTERM)? == SignalOutcome::GroupMissing {
        return Ok(TerminationOutcome::GroupMissing);
    }

    if wait_for_group_exit(GRACE_PERIOD)? {
        return Ok(TerminationOutcome::GroupMissing);
    }

    // Keep the leader unreaped through the final terminating signal and all
    // group-exit probes so the numeric PGID cannot be recycled underneath us.
    let kill_outcome = signal(group_id, SIGKILL)?;
    match kill_outcome {
        SignalOutcome::Succeeded => {
            if wait_for_group_exit(FORCE_KILL_PERIOD)? {
                Ok(TerminationOutcome::Complete)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("backend process group {group_id} survived SIGKILL"),
                ))
            }
        }
        SignalOutcome::GroupMissing => Ok(TerminationOutcome::GroupMissing),
        SignalOutcome::PermissionDenied => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "backend process group {group_id} could not be force-killed"
            ),
        )),
    }
}

pub(super) fn terminate_group(child: &Child) -> io::Result<()> {
    let group_id = group_id(child.id())?;
    let outcome = terminate_group_with(group_id, signal_group, |timeout| {
        wait_for_group_exit(group_id, timeout)
    })?;

    if outcome == TerminationOutcome::GroupMissing && !leader_has_exited(child)? {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "backend process group {group_id} is missing while its \
                 leader is still running"
            ),
        ));
    }

    Ok(())
}

#[cfg(test)]
pub(super) fn is_running(process_group_id: u32) -> io::Result<bool> {
    group_is_running(group_id(process_group_id)?)
}

#[cfg(test)]
pub(super) fn is_process_running(pid: u32) -> io::Result<bool> {
    let pid = group_id(pid)?;
    // SAFETY: `pid` is a validated positive process ID, and signal zero only
    // checks whether the process exists and may be signaled.
    let result = unsafe { posix_kill(pid, NO_SIGNAL) };
    if result == 0 {
        return Ok(true);
    }

    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ESRCH) {
        return Ok(false);
    }

    Err(error)
}

#[cfg(test)]
pub(super) fn process_group_id(pid: u32) -> io::Result<u32> {
    let pid = group_id(pid)?;
    // SAFETY: `pid` is a validated positive process ID.
    let process_group_id = unsafe { libc::getpgid(pid) };
    if process_group_id == -1 {
        return Err(io::Error::last_os_error());
    }

    u32::try_from(process_group_id).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("process group ID {process_group_id} is negative"),
        )
    })
}

#[cfg(test)]
pub(super) fn force_kill(process_group_id: u32) -> io::Result<()> {
    let group_id = group_id(process_group_id)?;
    match signal_group(group_id, SIGKILL)? {
        SignalOutcome::Succeeded | SignalOutcome::GroupMissing => Ok(()),
        SignalOutcome::PermissionDenied => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("backend process group {group_id} cannot be force-killed"),
        )),
    }
}

#[cfg(test)]
pub(super) fn reap(process_group_id: u32) -> io::Result<()> {
    let pid = group_id(process_group_id)?;
    let mut status = 0;
    // SAFETY: the PID belongs to a child created by the current test process,
    // and `status` points to writable storage for the duration of the call.
    let result = unsafe { posix_waitpid(pid, &mut status, 0) };
    if result == pid {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader},
        os::unix::process::CommandExt,
        process::{Child, Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    use super::*;

    struct TestGroup {
        child: Child,
        can_signal: bool,
        reaped: bool,
    }

    impl TestGroup {
        fn spawn(script: &str) -> Self {
            let child = Command::new("sh")
                .args(["-c", script])
                .process_group(0)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("test process group should start");
            Self {
                child,
                can_signal: true,
                reaped: false,
            }
        }

        fn descendant_pid(&mut self) -> u32 {
            let mut ready = String::new();
            BufReader::new(
                self.child
                    .stdout
                    .take()
                    .expect("test process should expose stdout"),
            )
            .read_line(&mut ready)
            .expect("test process should report descendant readiness");
            ready
                .trim()
                .parse()
                .expect("descendant readiness should contain its PID")
        }

        fn stop_and_reap(&mut self) -> io::Result<()> {
            terminate_group(&self.child)?;
            self.can_signal = false;
            self.child.wait()?;
            self.reaped = true;
            Ok(())
        }
    }

    impl Drop for TestGroup {
        fn drop(&mut self) {
            if self.reaped {
                return;
            }

            if self.can_signal && terminate_group(&self.child).is_err() {
                let _ = force_kill(self.child.id());
            }
            let _ = self.child.wait();
        }
    }

    fn wait_for_process_exit(pid: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if !is_process_running(pid).expect("descendant should be inspectable") {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    #[test]
    fn permission_denied_signal_means_the_group_still_exists() {
        let outcome = classify_signal_result(-1, io::Error::from_raw_os_error(1))
            .expect("permission denial should be a known signal outcome");

        assert_eq!(outcome, SignalOutcome::PermissionDenied);
        assert!(outcome.group_exists());
    }

    #[test]
    fn leader_exit_is_observed_without_reaping_the_child() {
        let child = Command::new("sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test child should start");

        let deadline = Instant::now() + Duration::from_secs(1);
        while !leader_has_exited(&child).expect("leader should be inspectable") {
            assert!(
                Instant::now() < deadline,
                "leader exit was not observed before the test deadline"
            );
            thread::sleep(POLL_INTERVAL);
        }

        reap(child.id()).expect("non-reaping inspection must preserve the exit status");
    }

    #[test]
    fn termination_sends_the_final_group_signal_before_reaping_is_allowed() {
        let mut signals = [
            (SIGTERM, SignalOutcome::Succeeded),
            (SIGKILL, SignalOutcome::Succeeded),
        ]
        .into_iter();
        let mut waits = [
            (GRACE_PERIOD, false),
            (FORCE_KILL_PERIOD, true),
        ]
        .into_iter();

        let outcome = terminate_group_with(
            42,
            |group_id, signal| {
                assert_eq!(group_id, 42);
                let (expected_signal, outcome) = signals.next().expect("unexpected extra signal");
                assert_eq!(signal, expected_signal);
                Ok(outcome)
            },
            |timeout| {
                let (expected_timeout, exited) = waits.next().expect("unexpected extra wait");
                assert_eq!(timeout, expected_timeout);
                Ok(exited)
            },
        )
        .expect("termination signals should complete");

        assert_eq!(outcome, TerminationOutcome::Complete);
        assert!(signals.next().is_none());
        assert!(waits.next().is_none());
    }

    #[test]
    fn wait_for_group_exit_retries_until_the_group_disappears() {
        let mut inspections = [true, false].into_iter();

        let exited = wait_for_group_exit_with(Duration::from_millis(100), || {
            Ok(inspections
                .next()
                .expect("wait loop inspected the group too many times"))
        })
        .expect("group inspection should be retried");

        assert!(exited);
        assert!(inspections.next().is_none());
    }

    #[test]
    fn terminate_attempts_force_kill_after_term_permission_denial() {
        let mut signals = [
            (SIGTERM, SignalOutcome::PermissionDenied),
            (SIGKILL, SignalOutcome::Succeeded),
        ]
        .into_iter();
        let mut waits = [
            (GRACE_PERIOD, false),
            (FORCE_KILL_PERIOD, true),
        ]
        .into_iter();

        let outcome = terminate_group_with(
            42,
            |group_id, signal| {
                assert_eq!(group_id, 42);
                let (expected_signal, outcome) = signals.next().expect("unexpected extra signal");
                assert_eq!(signal, expected_signal);
                Ok(outcome)
            },
            |timeout| {
                let (expected_timeout, exited) = waits.next().expect("unexpected extra wait");
                assert_eq!(timeout, expected_timeout);
                Ok(exited)
            },
        )
        .expect("force kill should still be attempted");

        assert_eq!(outcome, TerminationOutcome::Complete);
        assert!(signals.next().is_none());
        assert!(waits.next().is_none());
    }

    #[test]
    fn terminate_reports_force_kill_permission_denial() {
        let mut signals = [
            (SIGTERM, SignalOutcome::PermissionDenied),
            (SIGKILL, SignalOutcome::PermissionDenied),
        ]
        .into_iter();
        let mut waits = [(GRACE_PERIOD, false)].into_iter();

        let error = terminate_group_with(
            42,
            |group_id, signal| {
                assert_eq!(group_id, 42);
                let (expected_signal, outcome) = signals.next().expect("unexpected extra signal");
                assert_eq!(signal, expected_signal);
                Ok(outcome)
            },
            |timeout| {
                let (expected_timeout, exited) = waits.next().expect("unexpected extra wait");
                assert_eq!(timeout, expected_timeout);
                Ok(exited)
            },
        )
        .expect_err("persistent permission denial should be reported");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(signals.next().is_none());
        assert!(waits.next().is_none());
    }

    #[test]
    fn terminate_reports_timeout_when_a_group_survives_force_kill() {
        let mut signals = [
            (SIGTERM, SignalOutcome::Succeeded),
            (SIGKILL, SignalOutcome::Succeeded),
        ]
        .into_iter();
        let mut waits = [
            (GRACE_PERIOD, false),
            (FORCE_KILL_PERIOD, false),
        ]
        .into_iter();

        let error = terminate_group_with(
            42,
            |group_id, signal| {
                assert_eq!(group_id, 42);
                let (expected_signal, outcome) = signals.next().expect("unexpected extra signal");
                assert_eq!(signal, expected_signal);
                Ok(outcome)
            },
            |timeout| {
                let (expected_timeout, exited) = waits.next().expect("unexpected extra wait");
                assert_eq!(timeout, expected_timeout);
                Ok(exited)
            },
        )
        .expect_err("a group surviving SIGKILL should time out");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(signals.next().is_none());
        assert!(waits.next().is_none());
    }

    #[test]
    fn terminate_does_not_force_kill_a_group_that_exits_during_grace() {
        let mut signals = [(SIGTERM, SignalOutcome::Succeeded)].into_iter();
        let mut waits = [(GRACE_PERIOD, true)].into_iter();

        let outcome = terminate_group_with(
            42,
            |group_id, signal| {
                assert_eq!(group_id, 42);
                let (expected_signal, outcome) = signals.next().expect("unexpected extra signal");
                assert_eq!(signal, expected_signal);
                Ok(outcome)
            },
            |timeout| {
                let (expected_timeout, exited) = waits.next().expect("unexpected extra wait");
                assert_eq!(timeout, expected_timeout);
                Ok(exited)
            },
        )
        .expect("graceful group exit should complete");

        assert_eq!(outcome, TerminationOutcome::GroupMissing);
        assert!(signals.next().is_none());
        assert!(waits.next().is_none());
    }

    #[test]
    fn terminate_returns_missing_without_waiting_when_the_group_is_already_gone() {
        let mut signals = [(SIGTERM, SignalOutcome::GroupMissing)].into_iter();

        let outcome = terminate_group_with(
            42,
            |group_id, signal| {
                assert_eq!(group_id, 42);
                let (expected_signal, outcome) = signals.next().expect("unexpected extra signal");
                assert_eq!(signal, expected_signal);
                Ok(outcome)
            },
            |_| panic!("a missing group must not enter the grace wait"),
        )
        .expect("an already-missing group is an idempotent outcome");

        assert_eq!(outcome, TerminationOutcome::GroupMissing);
        assert!(signals.next().is_none());
    }

    #[test]
    fn terminate_stops_process_group_and_descendants() {
        let mut group = TestGroup::spawn("sleep 30 & descendant=$!; echo \"$descendant\"; wait");
        let pid = group.child.id();
        let descendant_pid = group.descendant_pid();

        assert!(is_running(pid).expect("process group should be inspectable"));
        assert!(
            is_process_running(descendant_pid).expect("descendant should be inspectable"),
            "descendant {descendant_pid} should exist before termination"
        );

        group
            .stop_and_reap()
            .expect("process group should terminate");
        assert!(
            wait_for_process_exit(descendant_pid),
            "descendant {descendant_pid} survived process-group termination"
        );
    }

    #[test]
    fn terminate_force_kills_a_term_ignoring_group() {
        let mut group =
            TestGroup::spawn("trap '' TERM; sleep 30 & descendant=$!; echo \"$descendant\"; wait");
        let descendant_pid = group.descendant_pid();

        assert!(
            is_process_running(descendant_pid).expect("descendant should be inspectable"),
            "descendant {descendant_pid} should exist before termination"
        );

        group
            .stop_and_reap()
            .expect("SIGKILL fallback should terminate the group");
        assert!(
            wait_for_process_exit(descendant_pid),
            "descendant {descendant_pid} survived SIGKILL fallback"
        );
    }
}
