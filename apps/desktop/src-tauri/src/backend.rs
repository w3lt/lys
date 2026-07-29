mod process_group;

use std::{
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use serde::Serialize;
use tauri::State;

#[derive(Default)]
pub struct Backend {
    process: Mutex<Option<Child>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    running: bool,
    pid: Option<u32>,
}

impl BackendStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            pid: None,
        }
    }
}

impl Backend {
    fn lock_process(&self) -> Result<std::sync::MutexGuard<'_, Option<Child>>, String> {
        self.process
            .lock()
            .map_err(|_| "backend process state is poisoned".to_owned())
    }

    fn stop(&self) -> Result<BackendStatus, String> {
        let mut process = self.lock_process()?;

        if running_pid(&mut process)?.is_none() {
            return Ok(BackendStatus::stopped());
        }

        let child = process
            .as_mut()
            .ok_or_else(|| "backend process handle disappeared while stopping".to_owned())?;
        process_group::terminate(child)
            .map_err(|error| format!("failed to stop backend process group: {error}"))?;
        *process = None;

        Ok(BackendStatus::stopped())
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        let process = match self.process.get_mut() {
            Ok(process) => process,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(child) = process.as_mut() else {
            return;
        };

        if let Err(error) = process_group::terminate(child) {
            eprintln!("failed to stop backend process group during shutdown: {error}");
            return;
        }

        *process = None;
    }
}

fn running_pid(child: &mut Option<Child>) -> Result<Option<u32>, String> {
    let pid = match child.as_mut() {
        Some(process) => {
            let pid = process.id();
            match process
                .try_wait()
                .map_err(|error| format!("failed to inspect backend process: {error}"))?
            {
                None => Some(pid),
                Some(_)
                    if process_group::is_running(pid).map_err(|error| {
                        format!("failed to inspect backend process group {pid}: {error}")
                    })? =>
                {
                    Some(pid)
                }
                Some(_) => None,
            }
        }
        None => None,
    };

    // Remove the handle only after the leader and all of its descendants exit.
    if pid.is_none() {
        *child = None;
    }

    Ok(pid)
}

#[tauri::command]
pub fn start_backend(backend: State<'_, Backend>) -> Result<BackendStatus, String> {
    let mut process = backend.lock_process()?;

    if let Some(pid) = running_pid(&mut process)? {
        return Ok(BackendStatus {
            running: true,
            pid: Some(pid),
        });
    }

    let backend_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../backend")
        .canonicalize()
        .map_err(|error| format!("failed to locate apps/backend: {error}"))?;

    let child = Command::new("pnpm")
        .args(["run", "dev"])
        .current_dir(backend_dir)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to start backend: {error}"))?;

    let pid = child.id();
    *process = Some(child);

    Ok(BackendStatus {
        running: true,
        pid: Some(pid),
    })
}

#[tauri::command]
pub fn stop_backend(backend: State<'_, Backend>) -> Result<BackendStatus, String> {
    backend.stop()
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader},
        os::unix::process::CommandExt,
        thread,
        time::{Duration, Instant},
    };

    use super::*;

    const ECHILD: i32 = 10;
    const TEST_TIMEOUT: Duration = Duration::from_secs(2);
    const TEST_POLL_INTERVAL: Duration = Duration::from_millis(10);

    struct ProcessGroupCleanup {
        pid: u32,
    }

    impl Drop for ProcessGroupCleanup {
        fn drop(&mut self) {
            let _ = process_group::force_kill(self.pid);
            let _ = process_group::reap(self.pid);
        }
    }

    fn wait_for_process_exit(pid: u32) -> bool {
        let deadline = Instant::now() + TEST_TIMEOUT;
        loop {
            if !process_group::is_process_running(pid).expect("test process should be inspectable")
            {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(TEST_POLL_INTERVAL);
        }
    }

    #[test]
    fn backend_defaults_to_stopped() {
        let backend = Backend::default();
        assert!(backend
            .process
            .lock()
            .expect("backend state should lock")
            .is_none());
    }

    #[test]
    fn stop_is_idempotent_without_a_child() {
        let backend = Backend::default();

        let first = backend.stop().expect("first stop should succeed");
        let second = backend.stop().expect("second stop should succeed");

        assert!(!first.running);
        assert_eq!(first.pid, None);
        assert!(!second.running);
        assert_eq!(second.pid, None);
    }

    #[test]
    fn running_pid_clears_an_exited_child() {
        let child = Command::new("sh")
            .args(["-c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test child should start");
        let child_pid = child.id();
        let mut process = Some(child);

        let deadline = Instant::now() + TEST_TIMEOUT;
        loop {
            let pid = running_pid(&mut process).expect("exited child should be inspectable");
            if pid.is_none() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "running_pid did not observe the child exit"
            );
            thread::sleep(TEST_POLL_INTERVAL);
        }

        assert!(process.is_none());
        let error = process_group::reap(child_pid)
            .expect_err("running_pid should have already reaped the direct child");
        assert_eq!(error.raw_os_error(), Some(ECHILD));
    }

    #[test]
    fn running_pid_retains_an_exited_leader_while_its_descendant_runs() {
        let mut child = Command::new("sh")
            .args([
                "-c",
                "sleep 30 & descendant=$!; echo \"$descendant\"; exit 0",
            ])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process group should start");
        let group_pid = child.id();
        let _cleanup = ProcessGroupCleanup { pid: group_pid };

        let mut ready = String::new();
        BufReader::new(
            child
                .stdout
                .take()
                .expect("test process should expose stdout"),
        )
        .read_line(&mut ready)
        .expect("test process should report descendant readiness");
        let descendant_pid: u32 = ready
            .trim()
            .parse()
            .expect("descendant readiness should contain its PID");
        assert!(
            process_group::is_process_running(descendant_pid)
                .expect("descendant should be inspectable"),
            "descendant {descendant_pid} should exist before leader exit"
        );
        child.wait().expect("process-group leader should exit");
        assert!(
            process_group::is_process_running(descendant_pid)
                .expect("descendant should be inspectable"),
            "descendant {descendant_pid} should remain after leader exit"
        );

        let backend = Backend {
            process: Mutex::new(Some(child)),
        };
        let inspected_pid = {
            let mut process = backend.process.lock().expect("backend state should lock");
            running_pid(&mut process).expect("backend process group should be inspectable")
        };

        assert_eq!(inspected_pid, Some(group_pid));
        let status = backend.stop().expect("backend process group should stop");
        assert!(!status.running);
        assert_eq!(status.pid, None);
        assert!(
            wait_for_process_exit(descendant_pid),
            "descendant {descendant_pid} survived backend stop"
        );
    }

    #[test]
    fn stop_terminates_and_clears_a_live_child() {
        let child = Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process group should start");
        let pid = child.id();
        let backend = Backend {
            process: Mutex::new(Some(child)),
        };

        let status = backend.stop().expect("backend should stop");

        assert!(!status.running);
        assert_eq!(status.pid, None);
        assert!(backend
            .process
            .lock()
            .expect("backend state should lock")
            .is_none());
        assert!(!process_group::is_running(pid).expect("process group should be inspectable"));
    }

    #[test]
    fn dropping_backend_terminates_its_process_group() {
        let child = Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process group should start");
        let pid = child.id();
        let backend = Backend {
            process: Mutex::new(Some(child)),
        };

        drop(backend);

        let still_running =
            process_group::is_running(pid).expect("process group should be inspectable");
        if still_running {
            process_group::force_kill(pid)
                .expect("failed-test cleanup should kill the process group");
            process_group::reap(pid).expect("failed-test cleanup should reap the direct child");
        }
        assert!(!still_running);
    }
}
