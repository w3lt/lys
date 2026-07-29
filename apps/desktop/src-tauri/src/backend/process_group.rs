use std::{
    io,
    process::Child,
    thread,
    time::{Duration, Instant},
};

const NO_SIGNAL: i32 = 0;
const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;
const ESRCH: i32 = 3;
const GRACE_PERIOD: Duration = Duration::from_secs(2);
const FORCE_KILL_PERIOD: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

unsafe extern "C" {
    #[link_name = "kill"]
    fn posix_kill(pid: i32, signal: i32) -> i32;
}

#[cfg(test)]
unsafe extern "C" {
    #[link_name = "waitpid"]
    fn posix_waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}

fn group_id(pid: u32) -> io::Result<i32> {
    i32::try_from(pid).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("backend PID {pid} does not fit in a POSIX process ID"),
        )
    })
}

fn signal_group(group_id: i32, signal: i32) -> io::Result<bool> {
    // SAFETY: `group_id` is a validated positive process ID. Negating it asks
    // POSIX `kill` to target that process group; `signal` is one of 0, 9, or 15.
    let result = unsafe { posix_kill(-group_id, signal) };
    if result == 0 {
        return Ok(true);
    }

    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ESRCH) {
        return Ok(false);
    }

    Err(io::Error::new(
        error.kind(),
        format!(
            "failed to send signal {signal} to backend process group \
             {group_id}: {error}"
        ),
    ))
}

fn group_is_running(group_id: i32) -> io::Result<bool> {
    signal_group(group_id, NO_SIGNAL)
}

fn wait_for_exit(child: &mut Child, group_id: i32, timeout: Duration) -> io::Result<bool> {
    let deadline = Instant::now() + timeout;

    loop {
        // Reap the direct child as soon as it exits while descendants finish.
        let _ = child.try_wait()?;

        if !group_is_running(group_id)? {
            return Ok(true);
        }

        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }

        thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

pub(super) fn terminate(child: &mut Child) -> io::Result<()> {
    let group_id = group_id(child.id())?;

    if !group_is_running(group_id)? {
        let _ = child.wait()?;
        return Ok(());
    }

    if signal_group(group_id, SIGTERM)? && wait_for_exit(child, group_id, GRACE_PERIOD)? {
        return Ok(());
    }

    if !signal_group(group_id, SIGKILL)? {
        let _ = child.wait()?;
        return Ok(());
    }

    if wait_for_exit(child, group_id, FORCE_KILL_PERIOD)? {
        return Ok(());
    }

    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!("backend process group {group_id} survived SIGKILL"),
    ))
}

pub(super) fn is_running(pid: u32) -> io::Result<bool> {
    group_is_running(group_id(pid)?)
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
pub(super) fn force_kill(pid: u32) -> io::Result<()> {
    let _ = signal_group(group_id(pid)?, SIGKILL)?;
    Ok(())
}

#[cfg(test)]
pub(super) fn reap(pid: u32) -> io::Result<()> {
    let pid = group_id(pid)?;
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
