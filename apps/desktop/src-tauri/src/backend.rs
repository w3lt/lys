mod process_group;

use std::{
    io,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use tauri::State;

#[derive(Clone, Default)]
pub struct Backend {
    inner: Arc<BackendInner>,
}

#[derive(Default)]
struct BackendInner {
    process: Mutex<Option<Child>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    running: bool,
    process_group_id: Option<u32>,
}

impl BackendStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            process_group_id: None,
        }
    }
}

impl Backend {
    fn lock_process(&self) -> Result<std::sync::MutexGuard<'_, Option<Child>>, String> {
        self.inner
            .process
            .lock()
            .map_err(|_| "backend process state is poisoned".to_owned())
    }

    fn start(&self) -> Result<BackendStatus, String> {
        self.start_with(spawn_backend)
    }

    fn start_with<F>(&self, spawn: F) -> Result<BackendStatus, String>
    where
        F: FnOnce() -> Result<Child, String>,
    {
        let mut process = self.lock_process()?;

        if let Some(process_group_id) = running_process_group_id(&mut process)? {
            return Ok(BackendStatus {
                running: true,
                process_group_id: Some(process_group_id),
            });
        }

        let child = spawn()?;
        let process_group_id = child.id();
        *process = Some(child);

        Ok(BackendStatus {
            running: true,
            process_group_id: Some(process_group_id),
        })
    }

    fn stop(&self) -> Result<BackendStatus, String> {
        self.stop_with(process_group::terminate)
    }

    fn stop_with<F>(&self, terminate: F) -> Result<BackendStatus, String>
    where
        F: FnOnce(&mut Child) -> io::Result<()>,
    {
        let mut process = self.lock_process()?;

        if running_process_group_id(&mut process)?.is_none() {
            return Ok(BackendStatus::stopped());
        }

        let child = process
            .as_mut()
            .ok_or_else(|| "backend process handle disappeared while stopping".to_owned())?;
        terminate(child)
            .map_err(|error| format!("failed to stop backend process group: {error}"))?;
        *process = None;

        Ok(BackendStatus::stopped())
    }
}

impl Drop for BackendInner {
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

fn running_process_group_id(child: &mut Option<Child>) -> Result<Option<u32>, String> {
    let process_group_id = match child.as_mut() {
        Some(process) => {
            let process_group_id = process.id();
            match process
                .try_wait()
                .map_err(|error| format!("failed to inspect backend process: {error}"))?
            {
                None => Some(process_group_id),
                Some(_)
                    if process_group::is_running(process_group_id).map_err(|error| {
                        format!(
                            "failed to inspect backend process group \
                             {process_group_id}: {error}"
                        )
                    })? =>
                {
                    Some(process_group_id)
                }
                Some(_) => None,
            }
        }
        None => None,
    };

    // Remove the handle only after the leader and all of its descendants exit.
    if process_group_id.is_none() {
        *child = None;
    }

    Ok(process_group_id)
}

fn repository_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .map_err(|error| format!("failed to locate repository root: {error}"))
}

fn backend_command(repository_root: &Path) -> Command {
    let mut command = Command::new("pnpm");
    command
        .arg("backend:dev")
        .current_dir(repository_root)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    command
}

fn spawn_backend() -> Result<Child, String> {
    backend_command(&repository_root()?)
        .spawn()
        .map_err(|error| format!("failed to start backend: {error}"))
}

async fn run_blocking<F, T>(operation: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("failed to join backend blocking task: {error}"))
}

#[tauri::command]
pub async fn start_backend(backend: State<'_, Backend>) -> Result<BackendStatus, String> {
    let backend = backend.inner().clone();
    run_blocking(move || backend.start()).await?
}

#[tauri::command]
pub async fn stop_backend(backend: State<'_, Backend>) -> Result<BackendStatus, String> {
    let backend = backend.inner().clone();
    run_blocking(move || backend.stop()).await?
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::OsStr,
        io::{self, BufRead, BufReader},
        os::unix::process::CommandExt,
        path::Path,
        sync::{mpsc, Barrier},
        thread,
        time::{Duration, Instant},
    };

    use super::*;

    const ECHILD: i32 = 10;
    const TEST_TIMEOUT: Duration = Duration::from_secs(2);
    const TEST_POLL_INTERVAL: Duration = Duration::from_millis(10);

    struct ProcessGroupCleanup {
        process_group_id: u32,
    }

    impl Drop for ProcessGroupCleanup {
        fn drop(&mut self) {
            let _ = process_group::force_kill(self.process_group_id);
            let _ = process_group::reap(self.process_group_id);
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

    fn backend_with_child(child: Child) -> Backend {
        Backend {
            inner: Arc::new(BackendInner {
                process: Mutex::new(Some(child)),
            }),
        }
    }

    #[test]
    fn backend_status_serializes_the_process_group_id() {
        let status = BackendStatus {
            running: true,
            process_group_id: Some(42),
        };

        assert_eq!(
            serde_json::to_value(status).expect("backend status should serialize"),
            serde_json::json!({
                "running": true,
                "processGroupId": 42,
            })
        );
    }

    #[test]
    fn backend_command_runs_the_root_backend_script() {
        let repository_root = Path::new("/tmp/lys-repository");
        let command = backend_command(repository_root);

        assert_eq!(command.get_program(), OsStr::new("pnpm"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![OsStr::new("backend:dev")]
        );
        assert_eq!(command.get_current_dir(), Some(repository_root));
    }

    #[test]
    fn start_returns_the_existing_process_group_without_spawning() {
        let child = Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process group should start");
        let process_group_id = child.id();
        let backend = backend_with_child(child);

        let status = backend
            .start_with(|| panic!("start should not launch a second process"))
            .expect("already-running backend should be reported");

        assert!(status.running);
        assert_eq!(status.process_group_id, Some(process_group_id));
    }

    #[test]
    fn start_replaces_an_exited_process_group() {
        let mut exited_child = Command::new("sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test child should start");
        exited_child
            .wait()
            .expect("test child should exit before restart");
        let backend = backend_with_child(exited_child);
        let replacement = Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("replacement process group should start");
        let replacement_group_id = replacement.id();

        let status = backend
            .start_with(|| Ok(replacement))
            .expect("exited backend should restart");

        assert!(status.running);
        assert_eq!(status.process_group_id, Some(replacement_group_id));
    }

    #[test]
    fn start_failure_leaves_the_backend_stopped() {
        let backend = Backend::default();

        let error = backend
            .start_with(|| Err("expected launcher failure".to_owned()))
            .expect_err("launcher failure should be returned");

        assert_eq!(error, "expected launcher failure");
        assert!(backend
            .inner
            .process
            .lock()
            .expect("backend state should lock")
            .is_none());
    }

    #[test]
    fn stop_failure_preserves_the_process_for_retry() {
        let child = Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process group should start");
        let backend = backend_with_child(child);

        let error = backend
            .stop_with(|_| Err(io::Error::other("expected termination failure")))
            .expect_err("termination failure should be returned");

        assert!(error.contains("expected termination failure"));
        assert!(backend
            .inner
            .process
            .lock()
            .expect("backend state should lock")
            .is_some());
    }

    #[test]
    fn start_waits_for_a_concurrent_stop_before_spawning() {
        let child = Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process group should start");
        let backend = backend_with_child(child);
        let stopping_backend = backend.clone();
        let starting_backend = backend.clone();
        let (stop_locked_sender, stop_locked_receiver) = mpsc::channel();
        let (release_stop_sender, release_stop_receiver) = mpsc::channel();
        let stop = thread::spawn(move || {
            stopping_backend.stop_with(|child| {
                stop_locked_sender
                    .send(())
                    .expect("test should observe the held stop lock");
                let _ = release_stop_receiver.recv();
                process_group::terminate(child)
            })
        });

        stop_locked_receiver
            .recv()
            .expect("stop should acquire the backend lock");
        let (start_attempted_sender, start_attempted_receiver) = mpsc::channel();
        let (spawned_sender, spawned_receiver) = mpsc::channel();
        let start = thread::spawn(move || {
            start_attempted_sender
                .send(())
                .expect("test should observe the start attempt");
            starting_backend.start_with(|| {
                spawned_sender
                    .send(())
                    .expect("test should observe the replacement spawn");
                Command::new("sh")
                    .args(["-c", "sleep 30 & wait"])
                    .process_group(0)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|error| format!("replacement process should start: {error}"))
            })
        });

        start_attempted_receiver
            .recv()
            .expect("start thread should reach the backend operation");
        assert!(
            matches!(spawned_receiver.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "start spawned a replacement while stop still held the backend lock"
        );

        release_stop_sender
            .send(())
            .expect("stop thread should still be waiting");
        let stop_status = stop
            .join()
            .expect("stop thread should finish")
            .expect("concurrent stop should succeed");
        let start_status = start
            .join()
            .expect("start thread should finish")
            .expect("start should resume after stop");

        assert!(!stop_status.running);
        assert!(start_status.running);
        spawned_receiver
            .recv()
            .expect("start should spawn exactly one replacement");
        assert!(matches!(
            spawned_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn blocking_operations_run_on_a_worker_thread() {
        let caller_thread = thread::current().id();

        let worker_thread = tauri::async_runtime::block_on(run_blocking(|| thread::current().id()))
            .expect("blocking operation should complete");

        assert_ne!(worker_thread, caller_thread);
    }

    #[test]
    fn dropping_a_backend_clone_keeps_the_shared_process_running() {
        let child = Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process group should start");
        let process_group_id = child.id();
        let backend = backend_with_child(child);
        let backend_clone = backend.clone();

        drop(backend_clone);

        assert!(process_group::is_running(process_group_id)
            .expect("process group should be inspectable"));
        drop(backend);
        assert!(!process_group::is_running(process_group_id)
            .expect("process group should be inspectable"));
    }

    #[test]
    fn concurrent_final_drops_terminate_the_shared_process_group() {
        for attempt in 1..=32 {
            let child = Command::new("sh")
                .args(["-c", "sleep 30 & wait"])
                .process_group(0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("test process group should start");
            let process_group_id = child.id();
            let backend = backend_with_child(child);
            let backend_clone = backend.clone();
            let start = Arc::new(Barrier::new(3));
            let first_start = Arc::clone(&start);
            let second_start = Arc::clone(&start);
            let first_drop = thread::spawn(move || {
                first_start.wait();
                drop(backend);
            });
            let second_drop = thread::spawn(move || {
                second_start.wait();
                drop(backend_clone);
            });

            start.wait();
            first_drop.join().expect("first drop thread should finish");
            second_drop
                .join()
                .expect("second drop thread should finish");

            let still_running = process_group::is_running(process_group_id)
                .expect("process group should be inspectable");
            if still_running {
                process_group::force_kill(process_group_id)
                    .expect("failed-test cleanup should kill the process group");
                process_group::reap(process_group_id)
                    .expect("failed-test cleanup should reap the direct child");
            }
            assert!(
                !still_running,
                "process group survived concurrent final drops on attempt {attempt}"
            );
        }
    }

    #[test]
    fn backend_defaults_to_stopped() {
        let backend = Backend::default();
        assert!(backend
            .inner
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
        assert_eq!(first.process_group_id, None);
        assert!(!second.running);
        assert_eq!(second.process_group_id, None);
    }

    #[test]
    fn running_process_group_id_clears_an_exited_child() {
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
            let process_group_id =
                running_process_group_id(&mut process).expect("exited child should be inspectable");
            if process_group_id.is_none() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "running_process_group_id did not observe the child exit"
            );
            thread::sleep(TEST_POLL_INTERVAL);
        }

        assert!(process.is_none());
        let error = process_group::reap(child_pid)
            .expect_err("process inspection should have already reaped the direct child");
        assert_eq!(error.raw_os_error(), Some(ECHILD));
    }

    #[test]
    fn running_process_group_id_retains_an_exited_leader_group() {
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
        let _cleanup = ProcessGroupCleanup {
            process_group_id: group_pid,
        };

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

        let backend = backend_with_child(child);
        let inspected_pid = {
            let mut process = backend
                .inner
                .process
                .lock()
                .expect("backend state should lock");
            running_process_group_id(&mut process)
                .expect("backend process group should be inspectable")
        };

        assert_eq!(inspected_pid, Some(group_pid));
        let status = backend.stop().expect("backend process group should stop");
        assert!(!status.running);
        assert_eq!(status.process_group_id, None);
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
        let process_group_id = child.id();
        let backend = backend_with_child(child);

        let status = backend.stop().expect("backend should stop");

        assert!(!status.running);
        assert_eq!(status.process_group_id, None);
        assert!(backend
            .inner
            .process
            .lock()
            .expect("backend state should lock")
            .is_none());
        assert!(!process_group::is_running(process_group_id)
            .expect("process group should be inspectable"));
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
        let process_group_id = child.id();
        let backend = backend_with_child(child);

        drop(backend);

        let still_running = process_group::is_running(process_group_id)
            .expect("process group should be inspectable");
        if still_running {
            process_group::force_kill(process_group_id)
                .expect("failed-test cleanup should kill the process group");
            process_group::reap(process_group_id)
                .expect("failed-test cleanup should reap the direct child");
        }
        assert!(!still_running);
    }
}
