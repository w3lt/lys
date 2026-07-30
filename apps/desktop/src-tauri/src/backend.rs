mod process_group;

use std::{
    io,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, TryLockError},
};

use serde::Serialize;
use tauri::State;

#[derive(Clone, Default)]
pub struct Backend {
    inner: Arc<BackendInner>,
}

#[derive(Default)]
struct BackendInner {
    process: Mutex<Option<BackendProcess>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackendProcessPhase {
    // The leader is live or an unreaped zombie, so its PID still pins the
    // process-group identity and group signals cannot hit a recycled PGID.
    Signalable,
    // The final group signal was already attempted. Only reaping is allowed;
    // retrying a negative-PGID signal from this phase would be unsafe.
    ReapOnly,
}

struct BackendProcess {
    child: Child,
    phase: BackendProcessPhase,
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

impl BackendProcess {
    fn new(child: Child) -> Self {
        Self {
            child,
            phase: BackendProcessPhase::Signalable,
        }
    }

    fn process_group_id(&self) -> u32 {
        self.child.id()
    }

    fn is_running(&self) -> io::Result<bool> {
        match self.phase {
            BackendProcessPhase::Signalable => {
                process_group::leader_has_exited(&self.child).map(|exited| !exited)
            }
            BackendProcessPhase::ReapOnly => Ok(false),
        }
    }

    fn stop(&mut self) -> io::Result<()> {
        self.stop_with(process_group::terminate_group, |child| {
            child.wait().map(|_| ())
        })
    }

    fn stop_with<T, R>(&mut self, terminate: T, reap: R) -> io::Result<()>
    where
        T: FnOnce(&Child) -> io::Result<()>,
        R: FnOnce(&mut Child) -> io::Result<()>,
    {
        if self.phase == BackendProcessPhase::Signalable {
            terminate(&self.child)?;
            // Change phase before reaping so even a wait failure cannot make a
            // later retry signal a PGID whose leader may have been collected.
            self.phase = BackendProcessPhase::ReapOnly;
        }

        reap(&mut self.child)
    }
}

impl Backend {
    fn lock_process(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<BackendProcess>>, String> {
        self.lock_process_observing_contention(|| {})
    }

    fn lock_process_observing_contention<O>(
        &self,
        on_contention: O,
    ) -> Result<std::sync::MutexGuard<'_, Option<BackendProcess>>, String>
    where
        O: FnOnce(),
    {
        match self.inner.process.try_lock() {
            Ok(process) => Ok(process),
            Err(TryLockError::WouldBlock) => {
                on_contention();
                self.inner
                    .process
                    .lock()
                    .map_err(|_| "backend process state is poisoned".to_owned())
            }
            Err(TryLockError::Poisoned(_)) => {
                Err("backend process state is poisoned".to_owned())
            }
        }
    }

    fn start(&self) -> Result<BackendStatus, String> {
        self.start_with(spawn_backend)
    }

    fn start_with<F>(&self, spawn: F) -> Result<BackendStatus, String>
    where
        F: FnOnce() -> Result<Child, String>,
    {
        self.start_with_contention_observer(|| {}, spawn)
    }

    fn start_with_contention_observer<O, F>(
        &self,
        on_contention: O,
        spawn: F,
    ) -> Result<BackendStatus, String>
    where
        O: FnOnce(),
        F: FnOnce() -> Result<Child, String>,
    {
        let mut process = self.lock_process_observing_contention(on_contention)?;

        if let Some(current) = process.as_mut() {
            if current.is_running().map_err(|error| {
                format!("failed to inspect backend process-group leader: {error}")
            })? {
                return Ok(BackendStatus {
                    running: true,
                    process_group_id: Some(current.process_group_id()),
                });
            }

            current.stop().map_err(|error| {
                format!("failed to clean up exited backend process group: {error}")
            })?;
            *process = None;
        }

        let child = spawn()?;
        let process_group_id = child.id();
        *process = Some(BackendProcess::new(child));

        Ok(BackendStatus {
            running: true,
            process_group_id: Some(process_group_id),
        })
    }

    fn stop(&self) -> Result<BackendStatus, String> {
        self.stop_with(BackendProcess::stop)
    }

    fn stop_with<F>(&self, terminate: F) -> Result<BackendStatus, String>
    where
        F: FnOnce(&mut BackendProcess) -> io::Result<()>,
    {
        let mut process = self.lock_process()?;

        let Some(current) = process.as_mut() else {
            return Ok(BackendStatus::stopped());
        };

        terminate(current)
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
        let Some(current) = process.as_mut() else {
            return;
        };

        if let Err(error) = current.stop() {
            eprintln!("failed to stop backend process group during shutdown: {error}");
            return;
        }

        *process = None;
    }
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
        fs,
        io::{self, BufRead, BufReader},
        os::unix::{fs::PermissionsExt, process::CommandExt},
        path::{Path, PathBuf},
        process,
        sync::{mpsc, Barrier},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    use super::*;

    const TEST_TIMEOUT: Duration = Duration::from_secs(5);
    const TEST_POLL_INTERVAL: Duration = Duration::from_millis(10);

    struct ChildCleanup {
        child: Option<Child>,
    }

    struct TemporaryDirectory {
        path: PathBuf,
    }

    impl Drop for ChildCleanup {
        fn drop(&mut self) {
            let Some(mut child) = self.child.take() else {
                return;
            };

            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }

    impl TemporaryDirectory {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after the Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "lys-{name}-{}-{unique}",
                process::id()
            ));
            fs::create_dir(&path).expect("temporary directory should be created");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
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
                process: Mutex::new(Some(BackendProcess::new(child))),
            }),
        }
    }

    fn spawn_group_with_descendant() -> (Child, u32) {
        let mut child = Command::new("sh")
            .args([
                "-c",
                "sleep 5 & descendant=$!; echo \"$descendant\"; wait",
            ])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process group should start");
        let mut ready = String::new();
        BufReader::new(
            child
                .stdout
                .take()
                .expect("test process should expose stdout"),
        )
        .read_line(&mut ready)
        .expect("test process should report descendant readiness");
        let descendant_pid = ready
            .trim()
            .parse()
            .expect("descendant readiness should contain its PID");

        (child, descendant_pid)
    }

    fn join_bounded<T>(handle: thread::JoinHandle<T>) -> thread::Result<T> {
        let deadline = Instant::now() + TEST_TIMEOUT;

        while !handle.is_finished() {
            let now = Instant::now();
            assert!(now < deadline, "worker thread exceeded the test timeout");
            thread::park_timeout(
                TEST_POLL_INTERVAL.min(deadline.saturating_duration_since(now)),
            );
        }

        handle.join()
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
    fn backend_command_starts_the_child_as_its_process_group_leader() {
        let fake_path = TemporaryDirectory::new("fake-pnpm");
        let fake_pnpm = fake_path.path().join("pnpm");
        fs::write(&fake_pnpm, "#!/bin/sh\nexec /bin/sleep 30\n")
            .expect("fake pnpm should be written");
        fs::set_permissions(&fake_pnpm, fs::Permissions::from_mode(0o755))
            .expect("fake pnpm should be executable");

        let mut command = backend_command(fake_path.path());
        command
            .env("PATH", fake_path.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = command
            .spawn()
            .expect("production backend command should spawn");
        let child_id = child.id();
        let _cleanup = ChildCleanup { child: Some(child) };

        assert_eq!(
            process_group::process_group_id(child_id)
                .expect("spawned child process group should be inspectable"),
            child_id,
            "the backend child must lead a new process group"
        );
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
        let exited_child = Command::new("sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test child should start");
        let deadline = Instant::now() + TEST_TIMEOUT;
        while !process_group::leader_has_exited(&exited_child)
            .expect("exited leader should be inspectable")
        {
            assert!(
                Instant::now() < deadline,
                "test leader did not exit before the deadline"
            );
            thread::sleep(TEST_POLL_INTERVAL);
        }
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
    fn reap_retry_never_signals_the_process_group_again() {
        let child = Command::new("sh")
            .args(["-c", "exec sleep 30"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process should start");
        let mut process = BackendProcess::new(child);

        let first_error = process
            .stop_with(
                |_| Ok(()),
                |_| Err(io::Error::other("expected reap failure")),
            )
            .expect_err("the first reap should fail");
        assert_eq!(first_error.to_string(), "expected reap failure");

        process
            .stop_with(
                |_| panic!("a reap retry must not signal the process group again"),
                |child| {
                    child.kill()?;
                    child.wait().map(|_| ())
                },
            )
            .expect("the reap-only retry should succeed");
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
    fn start_observes_contention_before_waiting_for_a_concurrent_stop() {
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
            stopping_backend.stop_with(|process| {
                stop_locked_sender
                    .send(())
                    .expect("test should observe the held stop lock");
                release_stop_receiver
                    .recv_timeout(TEST_TIMEOUT)
                    .map_err(|error| {
                        io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!("test never released the stop operation: {error}"),
                        )
                    })?;
                process.stop()
            })
        });

        stop_locked_receiver
            .recv_timeout(TEST_TIMEOUT)
            .expect("stop should hold the lifecycle lock");

        let (contended_sender, contended_receiver) = mpsc::channel();
        let (spawned_sender, spawned_receiver) = mpsc::channel();
        let start = thread::spawn(move || {
            starting_backend.start_with_contention_observer(
                || {
                    contended_sender
                        .send(())
                        .expect("test should observe start contention");
                },
                || {
                    let replacement = Command::new("sh")
                        .args(["-c", "sleep 30 & wait"])
                        .process_group(0)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|error| format!("replacement process should start: {error}"))?;
                    spawned_sender
                        .send(())
                        .expect("test should observe the replacement spawn");
                    Ok(replacement)
                },
            )
        });

        contended_receiver
            .recv_timeout(TEST_TIMEOUT)
            .expect("start should observe the held lifecycle lock");
        assert!(
            matches!(spawned_receiver.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "start spawned while stop still held the lifecycle lock"
        );

        release_stop_sender
            .send(())
            .expect("stop thread should still be waiting");
        let stop_status = join_bounded(stop)
            .expect("stop thread should finish")
            .expect("concurrent stop should succeed");
        let start_status = join_bounded(start)
            .expect("start thread should finish")
            .expect("start should resume after stop");

        spawned_receiver
            .recv_timeout(TEST_TIMEOUT)
            .expect("start should spawn after stop releases the lifecycle lock");
        assert!(!stop_status.running);
        assert!(start_status.running);
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
        let (child, descendant_pid) = spawn_group_with_descendant();
        let backend = backend_with_child(child);
        let backend_clone = backend.clone();

        drop(backend_clone);

        assert!(process_group::is_process_running(descendant_pid)
            .expect("backend descendant should be inspectable"));
        drop(backend);
        assert!(
            wait_for_process_exit(descendant_pid),
            "backend descendant survived the final Backend drop"
        );
    }

    #[test]
    fn concurrent_final_drops_terminate_the_shared_process_group() {
        for attempt in 1..=32 {
            let (child, descendant_pid) = spawn_group_with_descendant();
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
            join_bounded(first_drop).expect("first drop thread should finish");
            join_bounded(second_drop).expect("second drop thread should finish");

            assert!(
                wait_for_process_exit(descendant_pid),
                "backend descendant survived concurrent final drops on attempt {attempt}"
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
    fn start_cleans_up_descendants_of_an_exited_leader_before_spawning() {
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
        let deadline = Instant::now() + TEST_TIMEOUT;
        while !process_group::leader_has_exited(&child)
            .expect("exited leader should be inspectable")
        {
            assert!(
                Instant::now() < deadline,
                "process-group leader did not exit before the deadline"
            );
            thread::sleep(TEST_POLL_INTERVAL);
        }
        assert!(
            process_group::is_process_running(descendant_pid)
                .expect("descendant should be inspectable"),
            "descendant {descendant_pid} should remain after leader exit"
        );
        let backend = backend_with_child(child);
        let status = backend
            .start_with(move || {
                assert!(
                    !process_group::is_process_running(descendant_pid)
                        .expect("stale descendant should be inspectable"),
                    "replacement spawn began before stale descendants exited"
                );
                Command::new("sh")
                    .args(["-c", "sleep 30 & wait"])
                    .process_group(0)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|error| format!("replacement process should start: {error}"))
            })
            .expect("backend should restart after cleaning stale descendants");

        assert!(status.running);
        assert!(
            wait_for_process_exit(descendant_pid),
            "descendant {descendant_pid} survived stale-group cleanup"
        );
    }

    #[test]
    fn stop_terminates_and_clears_a_live_child() {
        let (child, descendant_pid) = spawn_group_with_descendant();
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
        assert!(
            wait_for_process_exit(descendant_pid),
            "backend descendant survived stop"
        );
    }

    #[test]
    fn dropping_backend_terminates_its_process_group() {
        let (child, descendant_pid) = spawn_group_with_descendant();
        let backend = backend_with_child(child);

        drop(backend);

        assert!(
            wait_for_process_exit(descendant_pid),
            "backend descendant survived Backend drop"
        );
    }
}
