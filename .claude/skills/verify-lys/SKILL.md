---
name: verify-lys
description: Launch the real Lys stack (backend from source, Vite-served desktop renderer in headless Chrome, a fake Ollama provider and a fake Tauri host at the production boundaries) and drive user workflows end to end with machine-readable results and screenshots. Use it to prove chat streaming, settings persistence, or backend lifecycle behavior after a change, or to check whether a regression is real; run it from the repository root on macOS.
---

# Verify Lys

Lys is a Tauri 2 desktop app: a React renderer (`apps/desktop`), a Rust host
(`apps/desktop/src-tauri`) that starts a Fastify backend (`apps/backend`) on
the fixed loopback port 12345, and a model provider the backend talks to over
HTTP. This skill launches that stack for one isolated run, drives it the way a
user would, and keeps evidence under `.agent-work/verify-lys/runs/<run-id>/`.

What is real: the backend runs from source with `tsx src/index.ts`, writes its
own SQLite database, settings reads, and logs under a scratch `LYS_HOME`; the
renderer is the real Vite-served UI on port 1420 with its real store, API
client, and server-sent-event handling; clicks are real mouse events and
typing is real text input in Chrome.

What stands in, each at a production boundary:

- `scripts/fake-ollama.mjs` answers as a local Ollama server (`/api/tags`,
  `/api/show`, `/api/ps`, `/v1/chat/completions`). It streams a fixed reply
  one word every 120 ms and answers title requests with a fixed title. The
  user's machine cannot run a local model, so no journey depends on one.
- `scripts/fake-host.mjs` answers the renderer's Tauri `invoke` calls over
  HTTP. Chrome cannot drive the desktop's WKWebView on macOS, so the renderer
  runs in headless Chrome with `window.__TAURI_INTERNALS__.invoke` forwarded
  to this host. It mirrors the Rust host: `load_settings` writes the default
  document when the file is missing, `save_settings` writes atomically with
  mode 0600, `start_backend`/`stop_backend` run the real backend in its own
  process group and stop it with `SIGTERM` then `SIGKILL`, vmo is reported
  stopped, and `list_tools` is empty.

Not covered, say so when asked: the Rust host's own code (only the opt-in
native probe below runs it, and it needs a GUI login session), vmo and
`read_page`, `web_search` (needs a Tavily key), MCP servers, client tools,
the LM Studio, Groq, and Ollama Cloud providers, the production backend
bundle (`dist/backend.mjs` is not what runs), and anything on a real
WKWebView.

Requirements: macOS, Node 24, `pnpm install` done (the harness runs
`apps/backend/node_modules/.bin/tsx` and `apps/desktop/node_modules/.bin/vite`
directly), Google Chrome in `/Applications`, `lsof` and `ps`. In Claude Code,
run every command below with the Bash sandbox disabled: Chrome, the servers,
and `lsof` do not work inside it. Never run it while `pnpm dev`,
`pnpm backend:dev`, or the installed Lys app is running: the backend port is
fixed and the harness refuses to double-drive it. The user's real `~/.lys` is
never read or written; every run gets its own `LYS_HOME`.

All commands run from the repository root:

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs <command> [options]
```

Exit codes: 0 every driven journey passed, 1 a journey failed, 2 the harness
itself failed (launch, missing tool, busy port), 3 nothing failed but a
journey was blocked by a missing precondition.

## Launch

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs launch
```

Creates `.agent-work/verify-lys/runs/<run-id>/` and starts, in order: the fake
provider on a free port, the scratch `LYS_HOME` seeded with `settings.json`
(Ollama active at the fake's address, vmo autostart off, everything else the
host's defaults), the fake host on a free port, the real backend through the
host's `start_backend`, Vite on port 1420 with `--strictPort`, and headless
Chrome with a scratch profile and a DevTools endpoint. Every process runs
detached in its own process group and is recorded in `run.json` with its pid
and start time as it starts, so a half-failed launch can still be cleaned up.

Ready means usable, not just answering: launch ends by opening the renderer
once and waiting for the composer placeholder `Say something to Caliginia`,
which needs the backend healthy, the provider connected, and a loaded model
listed. The last line of a good launch prints that placeholder. A launch
takes about 15 seconds; a cold Vite dependency pass can take a minute.

The run id is written to `.agent-work/verify-lys/runs/active-run`; `doctor`,
`drive`, and `cleanup` use it unless `--run <id>` names another. Launch
refuses while the active run's processes are alive or anything listens on
12345 or 1420, and names the pids.

## Doctor

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs doctor
```

Read-only. Prints JSON: Node version, missing tools, the active run, whether
each recorded process (provider, host, renderer, chrome) is still the one
started (pid and start time), who listens on 12345 and 1420, the backend's
health answer, the host's status (which backend pid it owns), the provider's
model list, and Chrome's version over DevTools. `drivable: true` and exit 0
mean the run is worth driving; exit 1 otherwise. Run it first whenever a
drive fails for no obvious reason.

## Drive

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs list
node .claude/skills/verify-lys/scripts/verify-lys.mjs drive
node .claude/skills/verify-lys/scripts/verify-lys.mjs drive --journey chat-stream-ui --journey backend-lifecycle-ui
node .claude/skills/verify-lys/scripts/verify-lys.mjs run            # launch + drive + cleanup
node .claude/skills/verify-lys/scripts/verify-lys.mjs run --keep     # same, but leave the stack running
```

Journeys and what each proves, grouped by feature file in `features/`:

| Journey                  | Feature              | Proof                                                                                                                                                                                                                                     |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend-health`         | backend-lifecycle    | `GET /api/v1/heath` answers `{ok: true}`; every pid listening on 12345 is in the host's backend process group; `GET /api/v1/llm/runtime` is `connected`; `GET /api/v1/llm/list` lists `lys-verify:latest` as loaded.                      |
| `chat-stream-api`        | chat-streaming       | `POST /api/v1/chat` streams `start-new-conversation-turn`, a `reply-part` text part, at least 10 timed `reply-part-delta` events spread over at least 1 s, `done` with `stop`, and `title`; the conversation route and SQLite rows match. |
| `chat-stream-ui`         | chat-streaming       | Typing and Send show the streaming caret, a Stop button, partial text mid-stream, the whole reply when done, and the titled conversation in Past conversations.                                                                           |
| `settings-generation-ui` | settings-persistence | Reply ceiling switch off writes `generation.replyCeiling: 0` to `settings.json`, survives a reload, and switches back to 2048.                                                                                                            |
| `settings-autostart-ui`  | settings-persistence | "Start it when Lys opens" off writes `runtime.autoStartBackend: false`, survives a reload, and switches back to true.                                                                                                                     |
| `backend-lifecycle-ui`   | backend-lifecycle    | Stop backend ends the process (status "Backend stopped", port closed, "stopping on a signal" logged); Start backend starts a new pid that answers health.                                                                                 |
| `host-lifecycle-native`  | backend-lifecycle    | Opt-in `--native`: the real Tauri debug binary with a fresh `LYS_HOME` writes the default `settings.json` with mode 0600, starts a backend, and stops it on quit. Needs a GUI login session and `cargo build`; opens a visible window.    |

Renderer journeys open a fresh Chrome page each, so renderer state never
leaks between them; the backend's database does carry over within a run, so
Past conversations lists earlier journeys' chats. Journeys run in the order
listed; `host-lifecycle-native` always runs last because it stops the harness
backend while the real app owns the port, and it starts it again at the end.

The renderer handles the journeys use are the app's own stable ones: the
composer textarea `textarea[aria-label^="Message "]` whose placeholder reads
`Say something to <agent>` when ready, `button.composer__send` reading
`Send` or `Stop`, `[data-testid="streaming-caret"]`,
`article.chat-view__message--lys`, `button[title="Settings"]`,
`button[title="Past conversations (⌘K)"]`, the dialog
`[aria-label="Past conversations"]`, the tabs under
`[aria-label="Settings sections"]` (text starts with the pane name:
Runtime, Model, Generation, Agents, Tools, MCP, Providers, Secrets), switches
`[role="switch"][aria-label="Reply ceiling"]` and
`[role="switch"][aria-label="Start it when Lys opens"]`, buttons
`[aria-label="Stop backend"]` and `[aria-label="Start backend"]`, and the
status region `[aria-label="Backend status"] h2` reading `Backend running`,
`Backend starting`, `Backend stopping`, `Backend stopped`, or
`Backend not responding`.

To prove the verifier itself is alive, hold the reply back in
`apps/backend/src/modules/chat/openAiReplyModel.ts` (accumulate
`choice.delta.content` and yield one text event at the finish reason), run
the two chat journeys, watch them fail on "at least 10 reply-part-delta
events" and "mid-stream text must show the reply's opening words", then
`git checkout -- apps/backend/src/modules/chat/openAiReplyModel.ts` and run
them again. That was done on 2026-11-01 and is recorded in the feature map.

## Evidence

Everything lands under `.agent-work/verify-lys/runs/<run-id>/`, which is
gitignored:

- `results.json`: `runId`, `head`, `dirtyFiles`, a `summary` of
  passed/failed/blocked counts, and one entry per journey with `status`,
  `durationMs`, its steps (`name`, `status`, `durationMs`, `detail`, and the
  run-relative `evidence` paths), and the `failure` text when it did not pass.
- `evidence/<journey>/NN-<name>`: screenshots (`.png`, 1180×820 like the
  desktop window), JSON observations (event timelines with arrival times, API
  bodies, SQLite rows, provider request log slices, host status), and text.
  A failed renderer step also keeps `NN-failure.png` and
  `NN-failure-page.txt` (the page's visible text) of what the page showed.
- `logs/`: `provider.log`, `provider-requests.ndjson`, `host.log`,
  `host-invocations.ndjson`, `backend-stdout.log`, `renderer.log`,
  `chrome.log`, and after cleanup `lys-home/` with the backend's own
  `logs/backend-YYYY-MM-DD.log`, the final `settings.json`, and
  `lys_db.sqlite`.
- `run.json`: what was started, where, with pids and start times.

Proof standards the journeys follow and new ones must keep: drive the real
user path (the composer, the Settings switches, the Stop/Start buttons), not
store setters or test-only routes; capture the action and the resulting
state (the mid-stream screenshot, not only the finished one); verify side
effects where they live (`settings.json` on disk, SQLite rows, the backend's
own log line, the port's listeners), not only what the screen shows; mock
only at the two production boundaries above. A journey that cannot meet a
precondition reports `blocked` with the reason; never weaken a check to make
it pass.

## Cleanup

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs cleanup
```

Stops, newest first, exactly the processes `run.json` recorded for the run:
Chrome, Vite, then the backend through the host's `stop_backend`, the host,
any backend the host recorded but could not stop (by the pid and start time
the host wrote to `state/backend-process.json`), and the provider. Each
stop checks that the pid still has the recorded start time before signalling
its process group with `SIGTERM`, then `SIGKILL` after 5 s. Nothing is ever
killed by process name. It then copies the scratch Lys home's logs, settings,
and database into `logs/lys-home/`, deletes `state/` (the Lys home and the
Chrome profile), clears `active-run`, and prints whether ports 12345 and
1420 are closed. `evidence/`, `logs/`, `results.json`, and `run.json` stay.

If cleanup reports a port still open, something outside the run's record
listens there. Find it with `lsof -nP -iTCP:12345 -sTCP:LISTEN`, compare its
pid and `ps -o lstart= -p <pid>` with `run.json` and `logs/host.log`, and
only then stop that process group. Old runs can be removed by deleting their
directories; `run.json` records `status: cleaned` once a run is torn down.

## Helpers

All executable, all under `.claude/skills/verify-lys/scripts/`:

- `verify-lys.mjs`: the command line (`launch`, `doctor`, `drive`,
  `cleanup`, `run`, `list`; options `--run <id>`, `--journey <id>` repeatable,
  `--native`, `--keep`).
- `fake-ollama.mjs --port-file <path> --request-log <path>`: the provider
  stand-in; listens on a free loopback port and writes it to the port file.
  Its fixed reply, model name, title, and word interval live in
  `lib/verificationProvider.mjs`, which the journeys import too.
- `fake-host.mjs --lys-home <dir> --port-file <path> --backend-log <path> --backend-record <path> --invocation-log <path> --renderer-origin http://localhost:1420`:
  the Tauri host stand-in; `POST /invoke {cmd, args}` answers
  `{ok: true, value}` or `{ok: false, error}`, `GET /status` reports the
  backend it owns.
- `lib/`: `stack.mjs` (launch, health, stop, doctor facts), `cdp.mjs` (a
  minimal DevTools client on Node's WebSocket), `rendererPage.mjs` (open a
  page with the Tauri shim, click, type, screenshot), `rendererSteps.mjs`
  (composer-ready wait, settings panes, switches, backend status heading),
  `journey.mjs` (steps, evidence recorder, `rejectUnless`, `JourneyBlocked`),
  `processControl.mjs` (detached start, identity by pid plus start time,
  group stop, port listeners), `httpProbe.mjs` (JSON requests, timed
  server-sent events, port probe), `settingsDocument.mjs` (the default
  settings document mirrored from the Rust host, atomic 0600 writes),
  `sqliteEvidence.mjs` (read-only `node:sqlite` rows), `runRecord.mjs` (run
  directories, `active-run`), `waiting.mjs` (bounded waits).
- `journeys/`: one file per journey plus `index.mjs`, which fixes the drive
  order. A new journey is a module exporting `{id, feature, title,
needsRenderer, needsNative, run(steps, context)}`; `steps.step(name, body)`
  records a step, `body(evidence)` gets `saveJson`, `saveText`, and
  `buildPath` for files it writes itself, and `context` carries `paths`,
  `backendUrl`, `hostUrl`, `providerUrl`, `openPage()`, and `native`.
  Register it in `index.mjs` and describe it in the matching feature file.

The feature map in `features/` is the maintained source of what is verified
and how; keep it honest with `/pstack:maintain-verification-skill` when the
app changes.
