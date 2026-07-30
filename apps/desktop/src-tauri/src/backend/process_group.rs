//! Ownership of the backend's POSIX process group.
//!
//! # Platform assumption
//!
//! This module is macOS-only and relies on Darwin's `kill(2)` semantics.
//!
//! The drain predicate asks "does this group still contain a signalable
//! member?" via `kill(-pgid, 0)`. On Darwin, a group whose only remaining
//! member is our own unreaped zombie leader answers `EPERM`, which
//! [`classify_owned_group`] combines with the leader state to conclude the
//! group is drained. Other Unixes do not agree: Linux keeps a zombie in its
//! process group until it is reaped and answers `0`, so the same group would
//! read as perpetually live and [`terminate_group_with`] would report that it
//! survived `SIGKILL`. Supporting another platform means replacing this probe
//! with real group-membership enumeration, not adding another errno arm.
//!
//! The leader is deliberately left unreaped until the group is drained: an
//! unreaped child pins the PGID, so the numeric group ID can never be recycled
//! underneath a signal we are about to send.

use std::{
    io,
    mem::MaybeUninit,
    process::{Child, ExitStatus},
    thread,
    time::{Duration, Instant},
};

const NO_SIGNAL: i32 = 0;
const GRACE_PERIOD: Duration = Duration::from_secs(2);
const FORCE_KILL_PERIOD: Duration = Duration::from_secs(1);
const STARTUP_OBSERVATION_PERIOD: Duration = Duration::from_millis(250);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GroupProbe {
    SignalableMember,
    NoSignalableMember,
    Missing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LeaderState {
    Running,
    Exited,
    ReapedExternally,
}

/// A leader that is still ours to reason about.
///
/// Once a leader has been reaped externally the group identity is gone, so that
/// case is resolved before classification rather than being carried into it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OwnedLeader {
    Running,
    Exited,
}

impl LeaderState {
    fn owned(self) -> Option<OwnedLeader> {
        match self {
            LeaderState::Running => Some(OwnedLeader::Running),
            LeaderState::Exited => Some(OwnedLeader::Exited),
            LeaderState::ReapedExternally => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OwnedGroupState {
    Active,
    Drained,
    IdentityLost,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Signalable,
    ReapOnly,
}

pub(super) struct ManagedProcessGroup {
    child: Child,
    group_id: i32,
    phase: Phase,
}

impl ManagedProcessGroup {
    pub(super) fn new(child: Child) -> io::Result<Self> {
        let group_id = checked_process_id(child.id())?;
        Ok(Self {
            child,
            group_id,
            phase: Phase::Signalable,
        })
    }

    pub(super) fn id(&self) -> u32 {
        self.child.id()
    }

    pub(super) fn is_running(&mut self) -> io::Result<bool> {
        if self.phase == Phase::ReapOnly {
            return Ok(false);
        }

        match inspect_leader(&self.child)? {
            LeaderState::Running => Ok(true),
            LeaderState::Exited => Ok(false),
            LeaderState::ReapedExternally => {
                self.phase = Phase::ReapOnly;
                Ok(false)
            }
        }
    }

    pub(super) fn observe_startup(&mut self) -> io::Result<bool> {
        if self.phase == Phase::ReapOnly {
            return Ok(false);
        }

        let stable =
            observe_startup_with(STARTUP_OBSERVATION_PERIOD, || inspect_leader(&self.child))?;
        if !stable && inspect_leader(&self.child)? == LeaderState::ReapedExternally {
            self.phase = Phase::ReapOnly;
        }
        Ok(stable)
    }

    pub(super) fn stop(&mut self) -> io::Result<Option<ExitStatus>> {
        let group_id = self.group_id;
        self.stop_with(|child| terminate_group(child, group_id), reap_child)
    }

    pub(super) fn stop_with<T, R>(
        &mut self,
        terminate: T,
        reap: R,
    ) -> io::Result<Option<ExitStatus>>
    where
        T: FnOnce(&Child) -> io::Result<()>,
        R: FnOnce(&mut Child) -> io::Result<Option<ExitStatus>>,
    {
        if self.phase == Phase::Signalable {
            terminate(&self.child)?;
            // The phase changes before wait. If wait fails, the retained
            // process can only retry reaping and can never signal a recycled
            // numeric PGID.
            self.phase = Phase::ReapOnly;
        }

        reap(&mut self.child)
    }
}

fn checked_process_id(process_id: u32) -> io::Result<i32> {
    i32::try_from(process_id).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("backend process-group ID {process_id} does not fit in a POSIX process ID"),
        )
    })
}

fn retry_interrupted<F, T>(mut operation: F) -> io::Result<T>
where
    F: FnMut() -> io::Result<T>,
{
    loop {
        match operation() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => return result,
        }
    }
}

fn inspect_leader(child: &Child) -> io::Result<LeaderState> {
    let process_id = checked_process_id(child.id())?;

    retry_interrupted(|| {
        // Darwin may leave siginfo untouched when WNOHANG observes no state
        // change. Recreate zeroed storage for every attempt, including after
        // EINTR, so a partial write can never become a false exit.
        let mut info = MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: process_id names our direct child, info is writable for the
        // call, and WNOWAIT deliberately preserves the waitable child and its
        // PID/PGID identity.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                process_id as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ECHILD) {
                return Ok(LeaderState::ReapedExternally);
            }
            return Err(error);
        }

        // SAFETY: the object was zero-initialized and waitid returned success.
        let info = unsafe { info.assume_init() };
        // SAFETY: si_pid is the valid union member for waitid child status.
        if unsafe { info.si_pid() } == 0 {
            Ok(LeaderState::Running)
        } else {
            Ok(LeaderState::Exited)
        }
    })
    .map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "failed to inspect backend process-group leader {process_id} without reaping it: {error}"
            ),
        )
    })
}

fn classify_signal_result(result: i32, error: io::Error) -> io::Result<GroupProbe> {
    if result == 0 {
        return Ok(GroupProbe::SignalableMember);
    }

    match error.raw_os_error() {
        Some(libc::EPERM) => Ok(GroupProbe::NoSignalableMember),
        Some(libc::ESRCH) => Ok(GroupProbe::Missing),
        _ => Err(error),
    }
}

fn signal_group(group_id: i32, signal: i32) -> io::Result<GroupProbe> {
    // SAFETY: group_id is a checked positive process ID. Its negation selects
    // that POSIX process group, and signal is 0, SIGTERM, or SIGKILL.
    let result = unsafe { libc::kill(-group_id, signal) };
    classify_signal_result(result, io::Error::last_os_error()).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("failed to send signal {signal} to backend process group {group_id}: {error}"),
        )
    })
}

fn classify_owned_group(probe: GroupProbe, leader: LeaderState) -> io::Result<OwnedGroupState> {
    let Some(leader) = leader.owned() else {
        return Ok(OwnedGroupState::IdentityLost);
    };

    // Every combination below is reachable, so the match needs no catch-all and
    // cannot regress into an `unreachable!()` panic on a lifecycle path.
    match (probe, leader) {
        (GroupProbe::SignalableMember, _) => Ok(OwnedGroupState::Active),
        (GroupProbe::NoSignalableMember, OwnedLeader::Exited)
        | (GroupProbe::Missing, OwnedLeader::Exited) => Ok(OwnedGroupState::Drained),
        (GroupProbe::NoSignalableMember, OwnedLeader::Running) => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "backend group has a live leader but no signalable member",
        )),
        (GroupProbe::Missing, OwnedLeader::Running) => Err(io::Error::new(
            io::ErrorKind::NotFound,
            "backend process group is missing while its leader is still running",
        )),
    }
}

fn signal_owned_group(child: &Child, group_id: i32, signal: i32) -> io::Result<OwnedGroupState> {
    let before_signal = inspect_leader(child)?;
    if before_signal == LeaderState::ReapedExternally {
        return Ok(OwnedGroupState::IdentityLost);
    }

    let probe = signal_group(group_id, signal)?;
    let leader = match probe {
        GroupProbe::SignalableMember => before_signal,
        // The leader may have exited between the first inspection and kill.
        GroupProbe::NoSignalableMember | GroupProbe::Missing => inspect_leader(child)?,
    };
    classify_owned_group(probe, leader)
}

fn probe_owned_group(child: &Child, group_id: i32) -> io::Result<OwnedGroupState> {
    let probe = signal_group(group_id, NO_SIGNAL)?;
    match probe {
        GroupProbe::SignalableMember => Ok(OwnedGroupState::Active),
        GroupProbe::NoSignalableMember | GroupProbe::Missing => {
            classify_owned_group(probe, inspect_leader(child)?)
        }
    }
}

fn wait_until_drained(child: &Child, group_id: i32, timeout: Duration) -> io::Result<bool> {
    wait_until_drained_with(timeout, || probe_owned_group(child, group_id))
}

fn wait_until_drained_with<F>(timeout: Duration, mut inspect: F) -> io::Result<bool>
where
    F: FnMut() -> io::Result<OwnedGroupState>,
{
    let deadline = Instant::now() + timeout;
    loop {
        match inspect()? {
            OwnedGroupState::Drained | OwnedGroupState::IdentityLost => {
                return Ok(true);
            }
            OwnedGroupState::Active => {}
        }

        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

fn terminate_group_with<S, W>(mut signal: S, mut wait_until_drained: W) -> io::Result<()>
where
    S: FnMut(i32) -> io::Result<OwnedGroupState>,
    W: FnMut(Duration) -> io::Result<bool>,
{
    match signal(libc::SIGTERM)? {
        OwnedGroupState::Drained | OwnedGroupState::IdentityLost => return Ok(()),
        OwnedGroupState::Active => {}
    }

    if wait_until_drained(GRACE_PERIOD)? {
        return Ok(());
    }

    match signal(libc::SIGKILL)? {
        OwnedGroupState::Drained | OwnedGroupState::IdentityLost => return Ok(()),
        OwnedGroupState::Active => {}
    }

    if wait_until_drained(FORCE_KILL_PERIOD)? {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "backend process group survived SIGKILL",
        ))
    }
}

fn terminate_group(child: &Child, group_id: i32) -> io::Result<()> {
    terminate_group_with(
        |signal| signal_owned_group(child, group_id, signal),
        |timeout| wait_until_drained(child, group_id, timeout),
    )
}

fn observe_startup_with<F>(observation_period: Duration, mut inspect: F) -> io::Result<bool>
where
    F: FnMut() -> io::Result<LeaderState>,
{
    let deadline = Instant::now() + observation_period;
    loop {
        if inspect()? != LeaderState::Running {
            return Ok(false);
        }

        let now = Instant::now();
        if now >= deadline {
            return Ok(true);
        }
        thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

fn reap_child(child: &mut Child) -> io::Result<Option<ExitStatus>> {
    match child.wait() {
        Ok(status) => Ok(Some(status)),
        Err(error) if error.raw_os_error() == Some(libc::ECHILD) => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        os::unix::process::CommandExt,
        process::{Command, Stdio},
        time::Duration,
    };

    use super::*;

    #[test]
    fn no_signalable_members_with_an_exited_leader_is_drained() {
        assert_eq!(
            classify_owned_group(GroupProbe::NoSignalableMember, LeaderState::Exited,)
                .expect("a zombie-only owned group should be drained"),
            OwnedGroupState::Drained,
        );
    }

    #[test]
    fn no_signalable_members_with_a_live_leader_is_a_permission_error() {
        let error = classify_owned_group(GroupProbe::NoSignalableMember, LeaderState::Running)
            .expect_err("EPERM must not hide a live owned leader");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn missing_group_with_a_live_leader_is_an_invariant_error() {
        let error = classify_owned_group(GroupProbe::Missing, LeaderState::Running)
            .expect_err("a live group leader cannot belong to a missing group");

        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn an_externally_reaped_leader_loses_group_identity() {
        assert_eq!(
            classify_owned_group(GroupProbe::SignalableMember, LeaderState::ReapedExternally,)
                .expect("identity loss is an explicit terminal state"),
            OwnedGroupState::IdentityLost,
        );
    }

    #[test]
    fn graceful_drain_does_not_send_sigkill() {
        let mut signals = [(libc::SIGTERM, OwnedGroupState::Active)].into_iter();
        let mut waits = [(GRACE_PERIOD, true)].into_iter();

        terminate_group_with(
            |signal| {
                let (expected, outcome) = signals.next().expect("unexpected extra group signal");
                assert_eq!(signal, expected);
                Ok(outcome)
            },
            |timeout| {
                let (expected, drained) = waits.next().expect("unexpected extra settle wait");
                assert_eq!(timeout, expected);
                Ok(drained)
            },
        )
        .expect("graceful drain should complete");

        assert!(signals.next().is_none());
        assert!(waits.next().is_none());
    }

    #[test]
    fn force_kill_is_followed_by_a_bounded_settle_wait() {
        let mut signals = [
            (libc::SIGTERM, OwnedGroupState::Active),
            (libc::SIGKILL, OwnedGroupState::Active),
        ]
        .into_iter();
        let mut waits = [(GRACE_PERIOD, false), (FORCE_KILL_PERIOD, true)].into_iter();

        terminate_group_with(
            |signal| {
                let (expected, outcome) = signals.next().expect("unexpected extra group signal");
                assert_eq!(signal, expected);
                Ok(outcome)
            },
            |timeout| {
                let (expected, drained) = waits.next().expect("unexpected extra settle wait");
                assert_eq!(timeout, expected);
                Ok(drained)
            },
        )
        .expect("SIGKILL settling should complete");

        assert!(signals.next().is_none());
        assert!(waits.next().is_none());
    }

    #[test]
    fn racing_sigkill_that_finds_a_drained_group_completes_without_waiting() {
        let mut signals = [
            (libc::SIGTERM, OwnedGroupState::Active),
            (libc::SIGKILL, OwnedGroupState::Drained),
        ]
        .into_iter();
        let mut waits = [(GRACE_PERIOD, false)].into_iter();

        terminate_group_with(
            |signal| {
                let (expected, outcome) = signals.next().expect("unexpected extra group signal");
                assert_eq!(signal, expected);
                Ok(outcome)
            },
            |timeout| {
                let (expected, drained) = waits.next().expect("unexpected extra settle wait");
                assert_eq!(timeout, expected);
                Ok(drained)
            },
        )
        .expect("a racing zombie-only SIGKILL result should be terminal");

        assert!(signals.next().is_none());
        assert!(waits.next().is_none());
    }

    #[test]
    fn a_group_that_survives_sigkill_reports_timeout() {
        let mut signals = [OwnedGroupState::Active, OwnedGroupState::Active].into_iter();
        let mut waits = [false, false].into_iter();

        let error = terminate_group_with(
            |_| Ok(signals.next().expect("unexpected extra signal")),
            |_| Ok(waits.next().expect("unexpected extra wait")),
        )
        .expect_err("a group surviving SIGKILL must fail");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn startup_observation_rejects_a_leader_that_exits_in_the_window() {
        let mut states = [LeaderState::Running, LeaderState::Exited].into_iter();

        let stable = observe_startup_with(Duration::from_millis(100), || {
            Ok(states.next().unwrap_or(LeaderState::Exited))
        })
        .expect("leader inspection should succeed");

        assert!(!stable);
    }

    #[test]
    fn interrupted_operations_are_retried() {
        let mut attempts = 0;

        let value = retry_interrupted(|| {
            attempts += 1;
            if attempts == 1 {
                Err(io::Error::from(io::ErrorKind::Interrupted))
            } else {
                Ok(42)
            }
        })
        .expect("the interrupted operation should be retried");

        assert_eq!(value, 42);
        assert_eq!(attempts, 2);
    }

    #[test]
    fn reap_failure_enters_reap_only_and_retry_never_signals_again() {
        let child = Command::new("sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process should start");
        let mut group =
            ManagedProcessGroup::new(child).expect("test process group should be valid");

        group
            .stop_with(
                |_| Ok(()),
                |_| Err(io::Error::other("expected reap failure")),
            )
            .expect_err("the first reap should fail");
        assert_eq!(group.phase, Phase::ReapOnly);

        group
            .stop_with(
                |_| panic!("a reap-only retry must never signal the PGID"),
                |child| child.wait().map(Some),
            )
            .expect("the reap-only retry should succeed");
    }

    #[test]
    fn signal_failure_stays_signalable_for_a_safe_retry() {
        let child = Command::new("sh")
            .args(["-c", "exec sleep 30"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process should start");
        let mut group =
            ManagedProcessGroup::new(child).expect("test process group should be valid");

        group
            .stop_with(
                |_| Err(io::Error::other("expected signal failure")),
                |_| panic!("reaping must not run after signal failure"),
            )
            .expect_err("the first signal should fail");
        assert_eq!(group.phase, Phase::Signalable);

        group
            .stop_with(
                |child| {
                    let process_id = checked_process_id(child.id())?;
                    // SAFETY: process_id names the direct child owned by this
                    // test; SIGKILL is used only for test cleanup.
                    if unsafe { libc::kill(process_id, libc::SIGKILL) } == 0 {
                        Ok(())
                    } else {
                        Err(io::Error::last_os_error())
                    }
                },
                |child| child.wait().map(Some),
            )
            .expect("the signalable retry should succeed");
    }

    struct ProcessGuard(Option<ManagedProcessGroup>);

    impl ProcessGuard {
        fn new(child: Child) -> Self {
            Self(Some(
                ManagedProcessGroup::new(child).expect("test process group should be valid"),
            ))
        }

        fn stop_and_disarm(&mut self) -> io::Result<Option<ExitStatus>> {
            let result = self
                .0
                .as_mut()
                .expect("test guard should own a process group")
                .stop();
            if result.is_ok() {
                self.0 = None;
            }
            result
        }
    }

    impl std::ops::Deref for ProcessGuard {
        type Target = ManagedProcessGroup;

        fn deref(&self) -> &Self::Target {
            self.0
                .as_ref()
                .expect("test guard should own a process group")
        }
    }

    impl std::ops::DerefMut for ProcessGuard {
        fn deref_mut(&mut self) -> &mut Self::Target {
            self.0
                .as_mut()
                .expect("test guard should own a process group")
        }
    }

    impl Drop for ProcessGuard {
        fn drop(&mut self) {
            let Some(group) = self.0.as_mut() else {
                return;
            };

            if group.phase == Phase::Signalable {
                // SAFETY: the unreaped direct child still pins this test-owned
                // process-group identity.
                unsafe {
                    libc::kill(-group.group_id, libc::SIGKILL);
                }
                group.phase = Phase::ReapOnly;
            }
            let _ = group.child.wait();
        }
    }

    fn wait_for_leader_exit(group: &ManagedProcessGroup) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if inspect_leader(&group.child).expect("leader inspection should succeed")
                == LeaderState::Exited
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "leader did not exit before the test deadline"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn real_startup_observation_rejects_an_immediate_exit() {
        let child = Command::new("sh")
            .args(["-c", "exit 7"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process should start");
        let mut group = ProcessGuard::new(child);

        assert!(!group
            .observe_startup()
            .expect("startup observation should succeed"));
        let status = group
            .stop_and_disarm()
            .expect("immediately exited group should be reaped")
            .expect("direct child exit status should be available");
        assert_eq!(status.code(), Some(7));
    }

    #[test]
    fn real_zombie_only_group_is_drained_and_reaped() {
        let child = Command::new("sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process should start");
        let mut group = ProcessGuard::new(child);
        wait_for_leader_exit(&group);

        assert_eq!(
            signal_group(group.group_id, NO_SIGNAL)
                .expect("Darwin group probe should classify the zombie-only group"),
            GroupProbe::NoSignalableMember,
        );
        let status = group
            .stop_and_disarm()
            .expect("zombie-only group should be drained and reaped")
            .expect("direct child exit status should be available");
        assert!(status.success());
    }

    #[test]
    fn real_exited_leader_with_a_live_descendant_is_stopped_as_one_group() {
        let child = Command::new("sh")
            .args(["-c", "sleep 30 & exit 0"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process should start");
        let mut group = ProcessGuard::new(child);
        wait_for_leader_exit(&group);

        assert_eq!(
            probe_owned_group(&group.child, group.group_id)
                .expect("live descendant should keep the group active"),
            OwnedGroupState::Active,
        );
        group
            .stop_and_disarm()
            .expect("the descendant and zombie leader should be cleaned together");
    }

    #[test]
    fn real_term_responsive_group_exits_during_the_grace_period() {
        let child = Command::new("sh")
            .args(["-c", "trap 'exit 0' TERM; sleep 30"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process should start");
        let mut group = ProcessGuard::new(child);

        assert!(group
            .observe_startup()
            .expect("startup observation should succeed"));
        let status = group
            .stop_and_disarm()
            .expect("TERM-responsive group should stop during the grace period")
            .expect("direct child exit status should be available");
        assert!(status.success());
    }

    #[test]
    fn real_term_ignoring_group_is_force_killed_and_reaped() {
        let child = Command::new("sh")
            // The finite sleep keeps a failed regression test from leaving an
            // indefinite helper process behind.
            .args(["-c", "trap '' TERM; exec sleep 30"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process should start");
        let mut group = ProcessGuard::new(child);

        assert!(group
            .observe_startup()
            .expect("startup observation should succeed"));
        group
            .stop_and_disarm()
            .expect("TERM-ignoring group should be force killed and reaped");
    }
}
