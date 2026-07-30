# Backend Lifecycle Implementation Record

> Every behavior change below was implemented test-first and reviewed before
> continuing.

**Goal:** Make the macOS development backend lifecycle correct, linearizable,
retry-safe, and explicitly tied to Tauri application exit.

**Architecture:** One shared `BackendState` owns an optional phased child and a
sticky shutdown flag behind a lifecycle mutex. The direct child remains
unreaped while process-group signals are possible; child-aware Darwin probes
distinguish live members from a drained zombie-only leader.

**Tech stack:** Rust 2021, Tauri 2, `std::process`, Darwin POSIX APIs through
`libc`.

## Global constraints

- Change only `apps/desktop/src-tauri`.
- Support the current macOS development workflow.
- Launch exactly `pnpm backend:dev` from the repository root.
- Preserve the serialized frontend `BackendStatus` contract.
- Provide atomic start, restart, and stop commands.
- Do not add automatic background restart or a supervisor thread.

## Task 1: Correct Darwin process-group observation

**Files:**

- Modify: `src/backend/process_group.rs`

**Interfaces:**

- Produces `ManagedProcessGroup::{new, id, is_running, observe_startup, stop}`.

- [x] Add tests showing that `EPERM` plus an exited leader is drained, while
  `EPERM` plus a live leader is an error.
- [x] Run the tests and confirm they fail against the old boolean
  `group_is_running` model.
- [x] Replace the boolean probe with explicit signal and owned-group outcomes.
- [x] Retry `waitid` after `EINTR`.
- [x] Add ordering tests for graceful drain, force kill, timeout, and
  zombie-only drain.
- [x] Run the process-group unit tests.

## Task 2: Harden the shared lifecycle state

**Files:**

- Modify: `src/backend/manager.rs`
- Modify: `src/backend.rs`

**Interfaces:**

- Produces:
  `Backend::start`,
  `Backend::restart`,
  `Backend::stop`, and
  `Backend::shutdown`.

- [x] Add tests for the sticky shutdown flag, immediate launcher exit, stop
  retry, reap-only retry, idempotency, atomic restart, and serialized
  lifecycle ordering.
- [x] Run the tests and confirm the new cases fail against the old state.
- [x] Replace `Mutex<Option<BackendProcess>>` with `Mutex<BackendState>`.
- [x] Keep restart cleanup and replacement spawn under one mutex acquisition.
- [x] Store a spawned child before bounded startup observation.
- [x] Preserve the exact child phase after every failure.
- [x] Replace the five-second test descendant with a thirty-second process and
  condition-based assertions.
- [x] Run all backend unit tests.

## Task 3: Wire synchronous Tauri exit cleanup

**Files:**

- Modify: `src/lib.rs`

**Interfaces:**

- Consumes: `Backend::shutdown(&self) -> Result<(), String>`.

- [x] Replace `Builder::run` with `Builder::build` followed by `App::run`.
- [x] Retrieve the managed `Backend` in `RunEvent::Exit`.
- [x] Call `shutdown` synchronously and report cleanup errors.
- [ ] Compile the full Tauri crate on its native platform. This runner lacks
  Linux GTK/pkg-config packages and an Apple Objective-C cross-compiler.

## Task 4: Verification and review

**Files:**

- Review: every changed file under `apps/desktop/src-tauri`

- [x] Run `cargo fmt --check`.
- [x] Run the isolated backend `cargo test` suite.
- [x] Run isolated backend Clippy with `-D warnings`.
- [x] Compile the production and test modules for `x86_64-apple-darwin`.
- [x] Review the complete diff for scope, unsafe-block contracts, child
  ownership, retry paths, and frontend compatibility.
- [x] Confirm the source branch contains no changes outside
  `apps/desktop/src-tauri`.
