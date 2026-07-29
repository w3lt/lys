use std::{
    io,
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
    Ok(signal_group(group_id, NO_SIGNAL)?.group_exists())
}

fn wait_for_exit(child: &mut Child, group_id: i32, timeout: Duration) -> io::Result<bool> {
    wait_for_exit_with(child, group_id, timeout, |group_id| {
        signal_group(group_id, NO_SIGNAL)
    })
}

fn wait_for_exit_with<F>(
    child: &mut Child,
    group_id: i32,
    timeout: Duration,
    mut inspect_group: F,
) -> io::Result<bool>
where
    F: FnMut(i32) -> io::Result<SignalOutcome>,
{
    let deadline = Instant::now() + timeout;

    loop {
        // Reap the direct child as soon as it exits while descendants finish.
        let _ = child.try_wait()?;

        if !inspect_group(group_id)?.group_exists() {
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
    mut wait_for_exit: W,
) -> io::Result<TerminationOutcome>
where
    S: FnMut(i32, i32) -> io::Result<SignalOutcome>,
    W: FnMut(Duration) -> io::Result<bool>,
{
    if !signal(group_id, NO_SIGNAL)?.group_exists() {
        return Ok(TerminationOutcome::GroupMissing);
    }

    let term_outcome = signal(group_id, SIGTERM)?;
    if !term_outcome.group_exists() {
        return Ok(TerminationOutcome::GroupMissing);
    }
    if wait_for_exit(GRACE_PERIOD)? {
        return Ok(TerminationOutcome::Complete);
    }

    let kill_outcome = signal(group_id, SIGKILL)?;
    if !kill_outcome.group_exists() {
        return Ok(TerminationOutcome::GroupMissing);
    }

    if wait_for_exit(FORCE_KILL_PERIOD)? {
        return Ok(TerminationOutcome::Complete);
    }

    match signal(group_id, NO_SIGNAL)? {
        SignalOutcome::GroupMissing => Ok(TerminationOutcome::GroupMissing),
        SignalOutcome::PermissionDenied => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "backend process group {group_id} still exists but cannot \
                 be signaled"
            ),
        )),
        SignalOutcome::Succeeded => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("backend process group {group_id} survived SIGKILL"),
        )),
    }
}

pub(super) fn terminate(child: &mut Child) -> io::Result<()> {
    let group_id = group_id(child.id())?;
    let outcome = terminate_group_with(group_id, signal_group, |timeout| {
        wait_for_exit(child, group_id, timeout)
    })?;

    if outcome == TerminationOutcome::GroupMissing {
        let _ = child.wait()?;
    }

    Ok(())
}

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
            Self { child }
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
    }

    impl Drop for TestGroup {
        fn drop(&mut self) {
            if terminate(&mut self.child).is_err() {
                let _ = force_kill(self.child.id());
                let _ = self.child.wait();
            }
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
    fn wait_for_exit_retries_a_temporarily_unsignalable_group() {
        let mut child = Command::new("sh")
            .args(["-c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test child should start");
        let mut outcomes =
            [SignalOutcome::PermissionDenied, SignalOutcome::GroupMissing].into_iter();

        let exited = wait_for_exit_with(&mut child, 1, Duration::from_millis(100), |_| {
            Ok(outcomes
                .next()
                .expect("wait loop inspected the group too many times"))
        })
        .expect("temporary permission denial should be retried");

        assert!(exited);
        assert!(outcomes.next().is_none());
    }

    #[test]
    fn terminate_retries_permission_denied_through_force_kill() {
        let mut signals = [
            (NO_SIGNAL, SignalOutcome::Succeeded),
            (SIGTERM, SignalOutcome::PermissionDenied),
            (SIGKILL, SignalOutcome::PermissionDenied),
        ]
        .into_iter();
        let mut waits = [(GRACE_PERIOD, false), (FORCE_KILL_PERIOD, true)].into_iter();

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
        .expect("temporary permission denial should be retried");

        assert_eq!(outcome, TerminationOutcome::Complete);
        assert!(signals.next().is_none());
        assert!(waits.next().is_none());
    }

    #[test]
    fn terminate_reports_persistent_permission_denied_after_both_timeouts() {
        let mut signals = [
            (NO_SIGNAL, SignalOutcome::PermissionDenied),
            (SIGTERM, SignalOutcome::PermissionDenied),
            (SIGKILL, SignalOutcome::PermissionDenied),
            (NO_SIGNAL, SignalOutcome::PermissionDenied),
        ]
        .into_iter();
        let mut waits = [(GRACE_PERIOD, false), (FORCE_KILL_PERIOD, false)].into_iter();

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
    fn terminate_reports_timeout_when_a_group_survives_sigkill() {
        let mut signals = [
            (NO_SIGNAL, SignalOutcome::Succeeded),
            (SIGTERM, SignalOutcome::Succeeded),
            (SIGKILL, SignalOutcome::Succeeded),
            (NO_SIGNAL, SignalOutcome::Succeeded),
        ]
        .into_iter();
        let mut waits = [(GRACE_PERIOD, false), (FORCE_KILL_PERIOD, false)].into_iter();

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
        .expect_err("a signalable group that survives SIGKILL should time out");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(signals.next().is_none());
        assert!(waits.next().is_none());
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

        terminate(&mut group.child).expect("process group should terminate");
        assert!(!is_running(pid).expect("process group should be inspectable"));
        assert!(
            wait_for_process_exit(descendant_pid),
            "descendant {descendant_pid} survived process-group termination"
        );
        assert!(group
            .child
            .try_wait()
            .expect("child status should be available")
            .is_some());
    }

    #[test]
    fn terminate_force_kills_a_term_ignoring_group() {
        let mut group =
            TestGroup::spawn("trap '' TERM; sleep 30 & descendant=$!; echo \"$descendant\"; wait");
        let pid = group.child.id();
        let descendant_pid = group.descendant_pid();

        assert!(
            is_process_running(descendant_pid).expect("descendant should be inspectable"),
            "descendant {descendant_pid} should exist before termination"
        );

        terminate(&mut group.child).expect("SIGKILL fallback should terminate the group");
        assert!(!is_running(pid).expect("process group should be inspectable"));
        assert!(
            wait_for_process_exit(descendant_pid),
            "descendant {descendant_pid} survived SIGKILL fallback"
        );
    }
}
