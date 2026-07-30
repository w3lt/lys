use std::{
    io,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex, MutexGuard, TryLockError},
};

use serde::Serialize;

use super::process_group::ManagedProcessGroup;

#[derive(Clone, Default)]
pub(crate) struct Backend {
    inner: Arc<BackendInner>,
}

#[derive(Default)]
struct BackendInner {
    state: Mutex<BackendState>,
}

#[derive(Default)]
struct BackendState {
    process: Option<ManagedProcessGroup>,
    shutting_down: bool,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendStatus {
    running: bool,
    process_group_id: Option<u32>,
}

impl BackendStatus {
    fn running(process_group_id: u32) -> Self {
        Self {
            running: true,
            process_group_id: Some(process_group_id),
        }
    }

    fn stopped() -> Self {
        Self {
            running: false,
            process_group_id: None,
        }
    }
}

impl Backend {
    fn lock_state(&self) -> MutexGuard<'_, BackendState> {
        self.lock_state_observing_contention(|| {})
    }

    fn lock_state_observing_contention<O>(&self, on_contention: O) -> MutexGuard<'_, BackendState>
    where
        O: FnOnce(),
    {
        match self.inner.state.try_lock() {
            Ok(state) => state,
            Err(TryLockError::WouldBlock) => {
                on_contention();
                self.inner
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
            }
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        }
    }

    pub(crate) fn start(&self) -> Result<BackendStatus, String> {
        self.start_with(
            spawn_backend,
            ManagedProcessGroup::observe_startup,
            ManagedProcessGroup::stop,
        )
    }

    fn start_with<S, V, C>(
        &self,
        spawn: S,
        verify_startup: V,
        cleanup: C,
    ) -> Result<BackendStatus, String>
    where
        S: FnOnce() -> Result<Child, String>,
        V: FnOnce(&mut ManagedProcessGroup) -> io::Result<bool>,
        C: FnMut(&mut ManagedProcessGroup) -> io::Result<Option<ExitStatus>>,
    {
        self.start_with_contention_observer(|| {}, spawn, verify_startup, cleanup)
    }

    fn start_with_contention_observer<O, S, V, C>(
        &self,
        on_contention: O,
        spawn: S,
        verify_startup: V,
        mut cleanup: C,
    ) -> Result<BackendStatus, String>
    where
        O: FnOnce(),
        S: FnOnce() -> Result<Child, String>,
        V: FnOnce(&mut ManagedProcessGroup) -> io::Result<bool>,
        C: FnMut(&mut ManagedProcessGroup) -> io::Result<Option<ExitStatus>>,
    {
        let mut state = self.lock_state_observing_contention(on_contention);
        if state.shutting_down {
            return Err("backend is shutting down".to_owned());
        }

        start_locked(&mut state, spawn, verify_startup, &mut cleanup)
    }

    pub(crate) fn restart(&self) -> Result<BackendStatus, String> {
        self.restart_with(
            spawn_backend,
            ManagedProcessGroup::observe_startup,
            ManagedProcessGroup::stop,
        )
    }

    fn restart_with<S, V, C>(
        &self,
        spawn: S,
        verify_startup: V,
        mut cleanup: C,
    ) -> Result<BackendStatus, String>
    where
        S: FnOnce() -> Result<Child, String>,
        V: FnOnce(&mut ManagedProcessGroup) -> io::Result<bool>,
        C: FnMut(&mut ManagedProcessGroup) -> io::Result<Option<ExitStatus>>,
    {
        let mut state = self.lock_state();
        if state.shutting_down {
            return Err("backend is shutting down".to_owned());
        }

        cleanup_stored_process(
            &mut state,
            &mut cleanup,
            "failed to stop backend process group before restart",
        )?;
        spawn_and_verify_locked(&mut state, spawn, verify_startup, &mut cleanup)
    }

    pub(crate) fn stop(&self) -> Result<BackendStatus, String> {
        self.stop_with(ManagedProcessGroup::stop)
    }

    fn stop_with<C>(&self, mut cleanup: C) -> Result<BackendStatus, String>
    where
        C: FnMut(&mut ManagedProcessGroup) -> io::Result<Option<ExitStatus>>,
    {
        let mut state = self.lock_state();
        cleanup_stored_process(
            &mut state,
            &mut cleanup,
            "failed to stop backend process group",
        )?;
        Ok(BackendStatus::stopped())
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        self.shutdown_with(ManagedProcessGroup::stop)
    }

    fn shutdown_with<C>(&self, mut cleanup: C) -> Result<(), String>
    where
        C: FnMut(&mut ManagedProcessGroup) -> io::Result<Option<ExitStatus>>,
    {
        let mut state = self.lock_state();
        // Set this before cleanup. A start already waiting for this mutex must
        // observe shutdown and reject instead of spawning after cleanup.
        state.shutting_down = true;
        cleanup_stored_process(
            &mut state,
            &mut cleanup,
            "failed to stop backend process group during application shutdown",
        )?;
        Ok(())
    }

    #[cfg(test)]
    fn with_process_for_test(process: ManagedProcessGroup) -> Self {
        Self {
            inner: Arc::new(BackendInner {
                state: Mutex::new(BackendState {
                    process: Some(process),
                    shutting_down: false,
                }),
            }),
        }
    }
}

fn start_locked<S, V, C>(
    state: &mut BackendState,
    spawn: S,
    verify_startup: V,
    cleanup: &mut C,
) -> Result<BackendStatus, String>
where
    S: FnOnce() -> Result<Child, String>,
    V: FnOnce(&mut ManagedProcessGroup) -> io::Result<bool>,
    C: FnMut(&mut ManagedProcessGroup) -> io::Result<Option<ExitStatus>>,
{
    if let Some(current) = state.process.as_mut() {
        if current
            .is_running()
            .map_err(|error| format!("failed to inspect backend leader: {error}"))?
        {
            return Ok(BackendStatus::running(current.id()));
        }

        cleanup_stored_process(state, cleanup, "failed to clean up the previous backend")?;
    }

    spawn_and_verify_locked(state, spawn, verify_startup, cleanup)
}

fn spawn_and_verify_locked<S, V, C>(
    state: &mut BackendState,
    spawn: S,
    verify_startup: V,
    cleanup: &mut C,
) -> Result<BackendStatus, String>
where
    S: FnOnce() -> Result<Child, String>,
    V: FnOnce(&mut ManagedProcessGroup) -> io::Result<bool>,
    C: FnMut(&mut ManagedProcessGroup) -> io::Result<Option<ExitStatus>>,
{
    let child = spawn()?;
    let group = ManagedProcessGroup::new(child)
        .map_err(|error| format!("failed to register backend process group: {error}"))?;
    let process_group_id = group.id();
    // Store ownership before observing startup. Every inspection and
    // cleanup error therefore leaves a reachable child handle.
    state.process = Some(group);

    let process = state.process.as_mut().ok_or_else(|| {
        "internal backend lifecycle error: spawned process ownership was not retained".to_owned()
    })?;
    let startup_result = verify_startup(process);
    match startup_result {
        Ok(true) => Ok(BackendStatus::running(process_group_id)),
        Ok(false) => {
            match cleanup_stored_process(
                state,
                cleanup,
                "failed to clean up the backend after startup failure",
            ) {
                Ok(status) => Err(format!(
                    "backend exited during startup ({})",
                    describe_exit_status(status),
                )),
                Err(cleanup_error) => {
                    Err(format!("backend exited during startup; {cleanup_error}"))
                }
            }
        }
        Err(inspection_error) => {
            match cleanup_stored_process(
                state,
                cleanup,
                "failed to clean up the backend after startup inspection failed",
            ) {
                Ok(_) => Err(format!(
                    "failed to inspect backend during startup: {inspection_error}"
                )),
                Err(cleanup_error) => Err(format!(
                    "failed to inspect backend during startup: {inspection_error}; {cleanup_error}"
                )),
            }
        }
    }
}

impl Drop for BackendInner {
    fn drop(&mut self) {
        let state = match self.state.get_mut() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.shutting_down = true;

        let Some(process) = state.process.as_mut() else {
            return;
        };
        if let Err(error) = process.stop() {
            eprintln!("failed to stop backend process group during fallback cleanup: {error}");
            return;
        }
        state.process = None;
    }
}

fn cleanup_stored_process<C>(
    state: &mut BackendState,
    cleanup: &mut C,
    error_context: &str,
) -> Result<Option<ExitStatus>, String>
where
    C: FnMut(&mut ManagedProcessGroup) -> io::Result<Option<ExitStatus>>,
{
    let Some(process) = state.process.as_mut() else {
        return Ok(None);
    };

    let status = cleanup(process).map_err(|error| format!("{error_context}: {error}"))?;
    state.process = None;
    Ok(status)
}

fn describe_exit_status(status: Option<ExitStatus>) -> String {
    status.map(|status| status.to_string()).unwrap_or_else(|| {
        "exit status unavailable because the child was already reaped".to_owned()
    })
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

#[cfg(test)]
mod tests {
    use std::{
        ffi::OsStr,
        io,
        os::unix::process::CommandExt,
        path::Path,
        process::{Command, Stdio},
        sync::mpsc,
        thread,
        time::Duration,
    };

    use super::*;

    const TEST_TIMEOUT: Duration = Duration::from_secs(5);

    fn spawn_group(script: &str) -> ManagedProcessGroup {
        let child = Command::new("sh")
            .args(["-c", script])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test process should start");
        ManagedProcessGroup::new(child).expect("test process group should be valid")
    }

    fn kill_and_reap_direct(group: &mut ManagedProcessGroup) -> io::Result<Option<ExitStatus>> {
        group.stop_with(
            |child| {
                let process_id = i32::try_from(child.id()).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "test PID overflow")
                })?;
                // SAFETY: process_id names the direct child owned by this
                // test; SIGKILL is used only for deterministic cleanup.
                if unsafe { libc::kill(process_id, libc::SIGKILL) } == 0 {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                }
            },
            |child| child.wait().map(Some),
        )
    }

    fn reap_without_group_signal(
        group: &mut ManagedProcessGroup,
    ) -> io::Result<Option<ExitStatus>> {
        group.stop_with(|_| Ok(()), |child| child.wait().map(Some))
    }

    #[test]
    fn backend_status_preserves_the_frontend_contract() {
        let status = BackendStatus::running(42);

        assert_eq!(
            serde_json::to_value(status).expect("status should serialize"),
            serde_json::json!({
                "running": true,
                "processGroupId": 42,
            }),
        );
    }

    #[test]
    fn backend_command_runs_the_root_backend_script() {
        let repository_root = Path::new("/tmp/lys-repository");
        let command = backend_command(repository_root);

        assert_eq!(command.get_program(), OsStr::new("pnpm"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![OsStr::new("backend:dev")],
        );
        assert_eq!(command.get_current_dir(), Some(repository_root));
    }

    #[test]
    fn backend_defaults_to_stopped() {
        let backend = Backend::default();
        let state = backend.lock_state();

        assert!(state.process.is_none());
        assert!(!state.shutting_down);
    }

    #[test]
    fn stop_is_idempotent_when_no_process_is_owned() {
        let backend = Backend::default();

        let first = backend
            .stop_with(|_| panic!("empty stop must not clean a process"))
            .expect("first stop should succeed");
        let second = backend
            .stop_with(|_| panic!("empty stop must remain idempotent"))
            .expect("second stop should succeed");

        assert_eq!(first, BackendStatus::stopped());
        assert_eq!(second, BackendStatus::stopped());
    }

    #[test]
    fn start_returns_the_existing_group_without_spawning() {
        let group = spawn_group("exec sleep 30");
        let group_id = group.id();
        let backend = Backend::with_process_for_test(group);

        let status = backend
            .start_with(
                || panic!("an already-running backend must not spawn"),
                |_| panic!("an already-running backend needs no startup observation"),
                kill_and_reap_direct,
            )
            .expect("running backend should be reported");

        assert_eq!(status, BackendStatus::running(group_id));
        backend
            .stop_with(kill_and_reap_direct)
            .expect("test backend should stop");
    }

    #[test]
    fn start_does_not_report_an_immediately_exited_launcher_as_running() {
        let backend = Backend::default();

        let error = backend
            .start_with(
                || {
                    Command::new("sh")
                        .args(["-c", "exit 7"])
                        .process_group(0)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|error| error.to_string())
                },
                |_| Ok(false),
                reap_without_group_signal,
            )
            .expect_err("an immediately exited launcher must fail start");

        assert!(error.contains("startup"));
        assert!(error.contains('7'));
        assert!(backend.lock_state().process.is_none());
    }

    #[test]
    fn startup_inspection_error_still_cleans_the_owned_child() {
        let backend = Backend::default();

        let error = backend
            .start_with(
                || {
                    Command::new("sh")
                        .args(["-c", "exit 0"])
                        .process_group(0)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|error| error.to_string())
                },
                |_| Err(io::Error::other("expected inspection failure")),
                reap_without_group_signal,
            )
            .expect_err("startup inspection failure should be returned");

        assert!(error.contains("expected inspection failure"));
        assert!(backend.lock_state().process.is_none());
    }

    #[test]
    fn failed_start_cleanup_retains_process_ownership_for_retry() {
        let backend = Backend::default();

        let error = backend
            .start_with(
                || {
                    Command::new("sh")
                        .args(["-c", "exec sleep 30"])
                        .process_group(0)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|error| error.to_string())
                },
                |_| Ok(false),
                |_| Err(io::Error::other("expected cleanup failure")),
            )
            .expect_err("cleanup failure should be returned");

        assert!(error.contains("expected cleanup failure"));
        assert!(backend.lock_state().process.is_some());
        backend
            .stop_with(kill_and_reap_direct)
            .expect("retained process should be retryable");
    }

    #[test]
    fn stop_failure_retains_process_ownership_for_retry() {
        let backend = Backend::with_process_for_test(spawn_group("exec sleep 30"));

        backend
            .stop_with(|_| Err(io::Error::other("expected stop failure")))
            .expect_err("stop failure should be returned");
        assert!(backend.lock_state().process.is_some());

        backend
            .stop_with(kill_and_reap_direct)
            .expect("second stop should resume cleanup");
        assert!(backend.lock_state().process.is_none());
    }

    #[test]
    fn restart_cleans_the_previous_group_before_spawning_its_replacement() {
        let backend = Backend::with_process_for_test(spawn_group("exec sleep 30"));
        let previous_group_id = backend
            .lock_state()
            .process
            .as_ref()
            .expect("test backend should own a process")
            .id();
        let previous_was_cleaned = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let spawn_observer = previous_was_cleaned.clone();
        let cleanup_observer = previous_was_cleaned.clone();

        let status = backend
            .restart_with(
                move || {
                    assert!(
                        spawn_observer.load(std::sync::atomic::Ordering::SeqCst),
                        "restart must clean the previous group before spawning"
                    );
                    Command::new("sh")
                        .args(["-c", "exec sleep 30"])
                        .process_group(0)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|error| error.to_string())
                },
                |_| Ok(true),
                move |group| {
                    let result = kill_and_reap_direct(group);
                    if result.is_ok() {
                        cleanup_observer.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    result
                },
            )
            .expect("restart should succeed");

        assert!(status.running);
        assert_ne!(status.process_group_id, Some(previous_group_id));
        backend
            .stop_with(kill_and_reap_direct)
            .expect("replacement backend should stop");
    }

    #[test]
    fn restart_cleanup_failure_retains_the_old_group_and_does_not_spawn() {
        let backend = Backend::with_process_for_test(spawn_group("exec sleep 30"));
        let previous_group_id = backend
            .lock_state()
            .process
            .as_ref()
            .expect("test backend should own a process")
            .id();

        let error = backend
            .restart_with(
                || panic!("restart must not spawn after cleanup failure"),
                |_| panic!("restart must not inspect after cleanup failure"),
                |_| Err(io::Error::other("expected restart cleanup failure")),
            )
            .expect_err("restart cleanup failure should be returned");

        assert!(error.contains("expected restart cleanup failure"));
        assert_eq!(
            backend
                .lock_state()
                .process
                .as_ref()
                .expect("old group ownership must be retained")
                .id(),
            previous_group_id,
        );
        backend
            .stop_with(kill_and_reap_direct)
            .expect("retained old backend should stop");
    }

    #[test]
    fn restart_after_shutdown_is_rejected_before_cleanup_or_spawn() {
        let backend = Backend::default();
        backend
            .shutdown_with(|_| panic!("empty shutdown must not clean a process"))
            .expect("shutdown should succeed");

        let error = backend
            .restart_with(
                || panic!("restart after shutdown must not spawn"),
                |_| panic!("restart after shutdown must not inspect"),
                |_| panic!("restart after shutdown must not clean"),
            )
            .expect_err("restart after shutdown must be rejected");

        assert_eq!(error, "backend is shutting down");
    }

    #[test]
    fn start_cannot_interleave_between_restart_cleanup_and_spawn() {
        let backend = Backend::with_process_for_test(spawn_group("exec sleep 30"));
        let restarting_backend = backend.clone();
        let restart_lock_probe = backend.clone();
        let starting_backend = backend.clone();
        let (restart_locked_tx, restart_locked_rx) = mpsc::channel();
        let (release_restart_tx, release_restart_rx) = mpsc::channel();
        let restart = thread::spawn(move || {
            restarting_backend.restart_with(
                move || {
                    assert!(matches!(
                        restart_lock_probe.inner.state.try_lock(),
                        Err(TryLockError::WouldBlock),
                    ));
                    Command::new("sh")
                        .args(["-c", "exec sleep 30"])
                        .process_group(0)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|error| error.to_string())
                },
                |_| Ok(true),
                |group| {
                    restart_locked_tx
                        .send(())
                        .expect("test should observe the restart lock");
                    release_restart_rx
                        .recv_timeout(TEST_TIMEOUT)
                        .map_err(|error| {
                            io::Error::new(
                                io::ErrorKind::TimedOut,
                                format!("test did not release restart: {error}"),
                            )
                        })?;
                    kill_and_reap_direct(group)
                },
            )
        });

        restart_locked_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("restart should hold the lifecycle lock");

        let (contended_tx, contended_rx) = mpsc::channel();
        let start = thread::spawn(move || {
            starting_backend.start_with_contention_observer(
                || {
                    contended_tx
                        .send(())
                        .expect("test should observe start contention");
                },
                || panic!("start must observe the replacement instead of spawning"),
                |_| panic!("an existing replacement needs no startup observation"),
                |_| panic!("an existing replacement needs no cleanup"),
            )
        });

        contended_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("start should wait behind restart");
        release_restart_tx
            .send(())
            .expect("restart should still be waiting");

        let restarted = restart
            .join()
            .expect("restart thread should finish")
            .expect("restart should succeed");
        let observed = start
            .join()
            .expect("start thread should finish")
            .expect("start should observe the replacement");

        assert_eq!(observed, restarted);
        backend
            .stop_with(kill_and_reap_direct)
            .expect("replacement backend should stop");
    }

    #[test]
    fn shutdown_is_sticky_and_rejects_every_later_start() {
        let backend = Backend::default();

        backend
            .shutdown_with(|_| panic!("empty shutdown must not clean a process"))
            .expect("shutdown should succeed");

        let error = backend
            .start_with(
                || panic!("start after shutdown must not spawn"),
                |_| panic!("start after shutdown must not inspect"),
                |_| panic!("start after shutdown must not clean"),
            )
            .expect_err("start after shutdown must be rejected");

        assert_eq!(error, "backend is shutting down");
    }

    #[test]
    fn a_start_queued_behind_shutdown_cannot_spawn_after_cleanup() {
        let backend = Backend::with_process_for_test(spawn_group("exec sleep 30"));
        let stopping_backend = backend.clone();
        let starting_backend = backend.clone();
        let (shutdown_locked_tx, shutdown_locked_rx) = mpsc::channel();
        let (release_shutdown_tx, release_shutdown_rx) = mpsc::channel();
        let shutdown = thread::spawn(move || {
            stopping_backend.shutdown_with(|group| {
                shutdown_locked_tx
                    .send(())
                    .expect("test should observe the shutdown lock");
                release_shutdown_rx
                    .recv_timeout(TEST_TIMEOUT)
                    .map_err(|error| {
                        io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!("test did not release shutdown: {error}"),
                        )
                    })?;
                kill_and_reap_direct(group)
            })
        });

        shutdown_locked_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("shutdown should hold the lifecycle lock");

        let (contended_tx, contended_rx) = mpsc::channel();
        let start = thread::spawn(move || {
            starting_backend.start_with_contention_observer(
                || {
                    contended_tx
                        .send(())
                        .expect("test should observe start contention");
                },
                || panic!("queued start must not spawn after shutdown"),
                |_| panic!("queued start must not inspect after shutdown"),
                |_| panic!("queued start must not clean after shutdown"),
            )
        });

        contended_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("start should wait behind shutdown");
        release_shutdown_tx
            .send(())
            .expect("shutdown should still be waiting");

        shutdown
            .join()
            .expect("shutdown thread should finish")
            .expect("shutdown should succeed");
        let error = start
            .join()
            .expect("start thread should finish")
            .expect_err("queued start should be rejected");

        assert_eq!(error, "backend is shutting down");
        assert!(backend.lock_state().process.is_none());
    }
}
