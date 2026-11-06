# Settings persistence

Settings changed in the Settings view are saved through the host to
`$LYS_HOME/settings.json` and read back when Lys opens again.

## Sub-features

- The Settings view (gear button in the composer) has panes Runtime, Model,
  Generation, Agents, Tools, MCP, Providers, and Secrets, reached from the
  rail `Settings sections`.
- A change in a pane is saved at once through the host's `save_settings`
  command; the host writes the whole document pretty-printed with a trailing
  newline, atomically, readable only by its owner (mode 0600).
- `load_settings` on start reads the file back; when it is missing the host
  writes the defaults first.
- Verified switches: Generation → `Reply ceiling` (`generation.replyCeiling`:
  2048 on, 0 off) and Runtime → `Start it when Lys opens`
  (`runtime.autoStartBackend`).
- Not covered: the temperature slider, model load configuration, provider
  addresses, secrets, location, tool switches, and MCP servers, which all go
  through the same save path but are not exercised.

## How to get to it (user POV)

Click the gear in the composer's bottom row to open Settings. Pick
Generation in the left rail and flip Reply ceiling off; the status line under
the pane reads `Saving generation settings…` and clears. Pick Runtime and
flip `Start it when Lys opens`; the row's status reads that the startup
switches saved. Quit and reopen Lys: both switches show what you left.

## Driving it with verify-lys

```sh
node .claude/skills/verify-lys/scripts/verify-lys.mjs run --journey settings-generation-ui --journey settings-autostart-ui
```

Both journeys are built by `scripts/journeys/settingsSwitchJourney.mjs` with
the pane, switch label, and field. Each opens the renderer, waits for the
composer to be ready, clicks `button[title="Settings"]`, clicks the tab under
`[aria-label="Settings sections"]` whose text starts with the pane name,
waits for the pane (Generation: the switch; Runtime: the
`[aria-label="Backend status"]` heading), reads
`[role="switch"][aria-label="<label>"]` and requires `aria-checked="true"`
(`01-before.png`), clicks it, waits until the run's
`state/lys-home/settings.json` holds the off value (`02-settings-after-off.json`,
`02-switched-off.png`), reloads the page, waits for the app shell (composer
and Settings button), opens the pane again and requires
`aria-checked="false"` (`03-after-reload.png`), clicks it again and waits
until the file holds the on value (`04-settings-restored.json`).

Expected end state: both journeys `passed` and the file back at the seeded
values. If a journey ends early the harness writes the on value back itself
and records that as an extra step.

## Gotchas

- The file is written by `scripts/fake-host.mjs`, which mirrors the Rust
  host's writer (`apps/desktop/src-tauri/src/settings.rs`): same key order,
  pretty JSON, trailing newline, mode 0600, temp file plus rename. The Rust
  writer itself is covered by its cargo tests and by the opt-in
  `host-lifecycle-native` journey, which compares the file the real host
  creates byte for byte with `DEFAULT_SETTINGS_DOCUMENT` in
  `scripts/lib/settingsDocument.mjs`. If a settings group is added in Rust,
  update that constant or the native journey fails.
- The seeded document is not the default: `providers.active` is `ollama` at
  the fake's address and `runtime.autoStartVmo` is `false` (the stack has no
  vmo). Journeys that read defaults must account for both.
- After the reload the journeys wait for the app shell, not a ready composer.
  Seen once on 2026-11-01: with `autoStartBackend` off and the backend still
  running, the reloaded renderer stayed at `Waiting on the backend…` for 60 s
  (the store's `startBackendWhenNeeded` path under React StrictMode's double
  init is the suspect); it was not reproduced in later runs. If it shows up
  again, the `composerPlaceholder` detail of the reload step records it.
- `waitForSettingsField` waits for the exact value; a save that lands late
  shows up as a time-out naming the value the file still holds.
