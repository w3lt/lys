# Backend Lifecycle Architecture

## Scope

This module manages one development backend on macOS. Tauri starts
`pnpm backend:dev` from the repository root, exposes start, atomic restart,
and idempotent stop commands, and synchronously cleans up the backend when the
application exits.

The backend command may create descendants (`pnpm`, `tsx watch`, and Node), so
the desktop process owns the entire process group rather than only the direct
child. Cleanup covers descendants that remain in that process group; a process
that deliberately escapes it with `setsid` or `setpgid` is outside this model.

## Chosen architecture

`Backend` is a cheap clone around one shared `BackendInner`. `BackendInner`
contains one mutex-protected `BackendState`:

```rust
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
```

The lifecycle mutex is held for the complete inspect, clean, spawn, startup
observation, stop, and reap operation. There is therefore exactly one process
owner and a total order for concurrent lifecycle commands.

Two alternatives were rejected:

- A dedicated supervisor thread would detect natural exits immediately, but
  adds channels, a second state machine, and thread shutdown behavior that the
  current command-driven product does not need.
- An async-runtime-owned child would make application-exit cleanup depend on a
  runtime that Tauri is already shutting down.

Natural exit is command-driven in this version: the next start, restart, stop,
or application exit detects the exited leader, cleans any surviving
same-group descendants, and reaps it. Automatic background restart is
deliberately outside this scope.

## Process state

`ManagedProcessGroup` has two internal phases:

| Phase | Meaning | Allowed operation |
| --- | --- | --- |
| `Signalable` | The direct child is unreaped, so its PID pins the process-group identity. | Inspect or signal `-pgid`. |
| `ReapOnly` | Group termination completed; a group signal must never be retried. | Wait/reap the direct child. |

The outer `Option` adds the stopped state:

```text
None -> Signalable -> ReapOnly -> None
```

Every error preserves both the child handle and its exact phase. A retry
therefore resumes safely. No replacement is spawned until the previous group
has drained and its leader has been reaped.

## Darwin group semantics

The direct child is created with `process_group(0)`, making its PID the PGID.
The leader is inspected with `waitid(..., WNOHANG | WNOWAIT)` so detecting an
exit does not release that PID for reuse.

On 64-bit Darwin, `kill(-pgid, 0)` has three materially different outcomes:

- success: at least one group member is signalable;
- `EPERM`: no member is signalable;
- `ESRCH`: the group is missing.

Darwin excludes zombies from the explicit process-group iteration. Therefore,
under this owned-group invariant—every live backend descendant retains the
desktop user's signal permission—`EPERM` plus an exited unreaped leader means
the group is drained. `EPERM` while the leader is live is a permission error,
not success. This distinction avoids both the zombie-only deadlock and the
unsafe rule “all EPERM means stopped.”

## Public and internal symbols

```rust
impl Backend {
    pub(crate) fn start(&self) -> Result<BackendStatus, String>;
    pub(crate) fn restart(&self) -> Result<BackendStatus, String>;
    pub(crate) fn stop(&self) -> Result<BackendStatus, String>;
    pub(crate) fn shutdown(&self) -> Result<(), String>;
}

#[tauri::command]
pub(crate) async fn start_backend(
    backend: State<'_, Backend>,
) -> Result<BackendStatus, String>;

#[tauri::command]
pub(crate) async fn restart_backend(
    backend: State<'_, Backend>,
) -> Result<BackendStatus, String>;

#[tauri::command]
pub(crate) async fn stop_backend(
    backend: State<'_, Backend>,
) -> Result<BackendStatus, String>;

impl ManagedProcessGroup {
    pub(super) fn new(child: Child) -> io::Result<Self>;
    pub(super) fn id(&self) -> u32;
    pub(super) fn is_running(&mut self) -> io::Result<bool>;
    pub(super) fn observe_startup(&mut self) -> io::Result<bool>;
    pub(super) fn stop(&mut self) -> io::Result<Option<ExitStatus>>;
}
```

`BackendStatus` keeps the existing frontend contract:

```json
{
  "running": true,
  "processGroupId": 12345
}
```

## Function flows

### Start

1. Move the synchronous operation to a blocking worker.
2. Acquire the lifecycle mutex.
3. Reject the operation if `shutting_down` is set.
4. If a stored leader is live, return its existing PGID without spawning.
5. If a stored leader exited, terminate remaining same-group descendants,
   transition to reap-only, reap the leader, and clear the slot.
6. Spawn `pnpm backend:dev` from the canonical repository root in a new process
   group.
7. Store the child before observing startup so every error path retains
   ownership.
8. Observe the leader for a bounded startup interval without reaping it.
9. If it exits during that interval, clean and reap it, leave the backend
   stopped, and return an error containing the exit status.
10. Otherwise return running with the PGID.

The startup interval detects an immediately failed launcher; it is not an HTTP
readiness guarantee.

### Restart

1. Move the synchronous operation to a blocking worker.
2. Acquire the lifecycle mutex once and reject the operation if
   `shutting_down` is set.
3. Stop and reap any stored group without releasing the mutex.
4. If cleanup fails, retain the old group and return the error without
   spawning.
5. Spawn, store, and observe the replacement using the same guarded start
   helper.
6. Return only the replacement PGID.

Restart is a single linearizable operation. Another start, stop, restart, or
shutdown cannot observe or modify the temporary stopped state between cleanup
and replacement spawn.

### Stop

1. Move the synchronous operation to a blocking worker.
2. Acquire the lifecycle mutex.
3. Return stopped when no process is stored.
4. In `Signalable`, send `SIGTERM` to the owned group.
5. Poll the child-aware Darwin group state for the grace period.
6. If signalable members remain, send `SIGKILL` and poll for a bounded settle
   period.
7. Once drained, transition to `ReapOnly` before waiting.
8. Reap the direct child and clear the slot.
9. On any failure, retain the process and phase for retry.

### Application exit

1. Build the Tauri app explicitly.
2. In `RunEvent::Exit`, acquire the same lifecycle mutex.
3. Set `shutting_down` before cleanup.
4. Stop and reap the backend synchronously.
5. Log a bounded cleanup failure and let Tauri exit.

The sticky flag is part of the same mutex state. A start already queued behind
exit cleanup wakes afterward, sees the flag, and cannot orphan a new backend.
`Drop` remains only a fallback for tests and non-Tauri ownership.

## Invariants

- At most one `ManagedProcessGroup` is owned.
- The direct child PID equals the PGID when it is stored.
- The leader is never reaped while negative-PGID signaling is still possible.
- No negative-PGID signal is sent from `ReapOnly`.
- The process slot is cleared only after a successful reap or confirmation
  that an external waiter already reaped the child.
- Start and stop are idempotent in the already-running and already-stopped
  states; restart always replaces a running group.
- A failed cleanup retains ownership and is retryable.
- Shutdown prevents every later start, including a command already waiting for
  the lifecycle mutex.
