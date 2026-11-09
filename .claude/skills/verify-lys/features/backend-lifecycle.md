# Backend lifecycle

The desktop host starts the Fastify backend on `127.0.0.1:12345` when Lys
opens (or when asked), reports whether it runs, stops it on request and on
quit, and the backend reports its health and its provider connection.

## Sub-features

- Health: `GET /api/v1/heath` (the route name is spelled that way) answers
  `{ok: true}`; the renderer polls it after a start.
- Provider connection: `GET /api/v1/llm/runtime` reports `connecting`,
  `connected`, or `unreachable`; `GET /api/v1/llm/list` lists models with
  `loaded`; the composer is ready only with a loaded model.
- Runtime pane: the `Lys backend` card shows the status heading (`Backend
running`, `starting`, `stopping`, `stopped`, `not responding`), Start
  (enabled only when stopped) and Stop, and the `Start it when Lys opens`
  switch.
- Stop sends `SIGTERM` to the backend's process group; the backend logs
  `The Lys backend is stopping on a signal` and exits; the host kills after a
  grace period. Start spawns a new process.
- Host start: with a fresh `LYS_HOME` the host writes the default
  `settings.json` (mode 0600) and, with autostart on, starts the backend;
  quitting the app stops it.
- Not covered: the vmo card, the `Backend not responding` path, the MCP
  process group cleanup on stop, the production bundle under
  `$LYS_HOME/runtime`.

## How to get to it (user POV)

Open Lys; the composer reads `Waiting on the backend…` and then `Say
something to Caliginia` once the backend and provider are up. Open Settings →
Runtime: the first card reads `Backend running` with the address and uptime.
Press Stop: the heading reads `Backend stopping`, then `Backend stopped`, and
Start becomes enabled. Press Start: `Backend starting`, then `Backend
running`, and the composer becomes ready again.

## Driving it with verify-lys

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs run --journey backend-health --journey backend-lifecycle-ui
node .claude/skills/verify-lys/scripts/verify-lys.mjs run --native --journey host-lifecycle-native   # from a GUI Terminal only
```

`backend-health` (`scripts/journeys/backendHealth.mjs`) checks the health
answer (`01-health.json`); that every pid `lsof` lists on 12345 has the
process group of the backend pid the host reports (`02-port-owner.json`);
that the runtime is `connected`, asking `POST /api/v1/llm/runtime/connect`
once if not (`03-runtime.json`); and that `lys-verify:latest` is listed with
`loaded: true` (`04-llm-list.json`).

`backend-lifecycle-ui` (`scripts/journeys/backendLifecycleUi.mjs`) opens
Settings → Runtime, waits for `[aria-label="Backend status"] h2` to read
`Backend running` (`01-running.png`), records the host's backend pid, clicks
`button[aria-label="Stop backend"]`, waits for `Backend stopped`, waits for
`The Lys backend is stopping on a signal` in the run's
`state/lys-home/logs/backend-*.log`, checks port 12345 is closed and the
host reports `running: false` (`02-stopped.png`, `02-after-stop.json`),
clicks `button[aria-label="Start backend"]`, waits for `Backend running`,
checks health and that the host's pid changed (`03-restarted.png`,
`03-after-start.json`).

`host-lifecycle-native` (`scripts/journeys/hostLifecycleNative.mjs`,
opt-in with `--native`) stops the harness backend, starts
`apps/desktop/src-tauri/target/debug/lys-desktop` with a fresh `LYS_HOME`
under the run's state, waits for its `settings.json` and compares it byte for
byte with the harness's default document, checks mode 0600 and a listener on
12345, sends the app a quit event with `osascript`, waits for its process to
end and the port to close, then starts the harness backend again. It never
captures the screen.

Expected end state: `backend-health` and `backend-lifecycle-ui` `passed`;
`host-lifecycle-native` `passed` when run from a logged-in GUI session, else
`blocked` with the reason.

## Gotchas

- The backend's port is fixed, so only one backend can exist on the machine:
  the harness refuses to launch while 12345 or 1420 is taken, and the native
  journey stops the harness backend before the real app starts its own.
- The listening pid is not the pid the host started: `tsx` runs the backend
  in a child process. Compare process groups, not pids.
- `node_modules/.bin/tsx` is a shell wrapper that `exec`s Node, so the command
  line `ps` shows changes after the spawn. Process identity in this harness is
  pid plus start time; a check on the command line reports a live backend as
  gone and spawns a second one that fails on the busy port.
- The host in this stack is `scripts/fake-host.mjs`; Stop and Start prove the
  renderer's store, the host contract (`start_backend`, `stop_backend`,
  `get_backend_status` returning `{pid, running}`), and the backend's signal
  handling, not the Rust host's own process code. That is what the native
  journey is for, and it could not be proved on 2026-11-01: the harness ran
  over SSH (`launchctl managername` reports `Background`), where the Tauri
  binary cannot open a window and never creates `settings.json`. Run it from a
  Terminal on the Mac after `cargo build` in `apps/desktop/src-tauri`; it
  opens a visible window and may ask for Automation permission for the quit
  event. If the quit event is refused, the journey falls back to `SIGTERM`
  (which does not run the host's exit handler), stops any backend left on the
  port by identity, and reports `blocked`.
- The real debug host starts the backend with `pnpm run dev` in
  `apps/backend`, so `pnpm` must be on the PATH of whatever starts the app.
