use std::{
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
};

use nix::{
    errno::Errno,
    sys::signal::{killpg, Signal},
    unistd::Pid,
};
use tauri::State;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendProcessStatus {
    pub pid: Option<u32>,
    pub running: bool,
}

fn stopped_backend_status() -> BackendProcessStatus {
    BackendProcessStatus {
        pid: None,
        running: false,
    }
}

fn running_backend_status(pid: u32) -> BackendProcessStatus {
    BackendProcessStatus {
        pid: Some(pid),
        running: true,
    }
}

#[derive(Default)]
pub struct Backend {
    process: Mutex<Option<Child>>,
}

impl Backend {
    pub fn status(&self) -> Result<BackendProcessStatus, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|err| format!("Failed to lock backend state: {err}"))?;

        inspect_process(process.as_mut())
    }

    pub fn stop(&self) -> Result<BackendProcessStatus, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|err| format!("Failed to lock backend state: {err}"))?;

        let Some(child) = process.as_mut() else {
            return Ok(stopped_backend_status());
        };

        match child.try_wait() {
            Ok(Some(_exit_status)) => {
                // The direct child already exited
                *process = None;
                Ok(stopped_backend_status())
            }

            Ok(None) => {
                let pid = child.id();

                terminate_backend_process_group(pid)?;

                child
                    .wait()
                    .map_err(|err| format!("Failed to wait for backend process {pid}: {err}"))?;

                *process = None;

                Ok(stopped_backend_status())
            }

            Err(err) => Err(format!("Failed to inspect backend process: {err}")),
        }
    }
}

fn terminate_backend_process_group(pid: u32) -> Result<(), String> {
    let process_group = i32::try_from(pid)
        .map(Pid::from_raw)
        .map_err(|_| format!("Backend PID {pid} is outside the supported range"))?;

    match killpg(process_group, Signal::SIGKILL) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(err) => Err(format!(
            "Failed to terminate backend process group {pid}: {err}"
        )),
    }
}

fn inspect_process(process: Option<&mut Child>) -> Result<BackendProcessStatus, String> {
    let Some(child) = process else {
        return Ok(stopped_backend_status());
    };

    match child.try_wait() {
        Ok(None) => Ok(running_backend_status(child.id())),

        Ok(Some(_exited_status)) => Ok(stopped_backend_status()),

        Err(err) => Err(format!("Failed to inspect backend process: {err}")),
    }
}

fn get_backend_dir() -> Result<PathBuf, String> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| String::from("Failed to resolve apps directory"))?
        .join("backend"))
}

fn run_backend_dev_script(backend_dir: &Path) -> Result<Child, String> {
    Command::new("pnpm")
        .args(["run", "dev"])
        .current_dir(backend_dir)
        .process_group(0)
        .spawn()
        .map_err(|err| format!("Failed to spawn backend process: {err}"))
}

fn spawn_backend_process(backend: &Backend) -> Result<BackendProcessStatus, String> {
    let backend_dir = get_backend_dir()?;

    // Lock before spawning so we never create a process that we cannot store.
    let mut process = backend
        .process
        .lock()
        .map_err(|err| format!("Failed to lock backend state: {err}"))?;

    let backend_process = run_backend_dev_script(&backend_dir)?;

    *process = Some(backend_process);

    inspect_process(process.as_mut())
}

#[tauri::command]
pub fn start_backend(backend: State<'_, Backend>) -> Result<BackendProcessStatus, String> {
    // Step 1. Get backend process status
    let backend_status = backend.status()?;

    // Step 2. If backend process is running, we return without doing anything
    if backend_status.running {
        return Ok(backend_status);
    }

    // Step 3. If the backend process is not runnning, we spawn a new one
    spawn_backend_process(&backend)
}

#[tauri::command]
pub fn stop_backend(backend: State<'_, Backend>) -> Result<BackendProcessStatus, String> {
    backend.stop()
}

#[tauri::command]
pub fn get_backend_status(backend: State<'_, Backend>) -> Result<BackendProcessStatus, String> {
    backend.status()
}
