# Changelog

All notable changes to Lys are recorded in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and each release
version is the `major.minor.patch` value of the root `VERSION` file.

This log starts at 0.3.0. Earlier versions are recorded only by their Git tags.

## [0.3.0] - 2026-10-02

### Added

- Conversation history. The Composer's **Past conversations** button or
  `Ctrl/Cmd+K` opens a panel that lists stored conversations newest first and
  searches their titles and messages. A conversation can be renamed, deleted
  after confirmation, or reopened and continued with its saved system prompt and
  earlier messages as model context.
  ([#54](https://github.com/w3lt/lys/pull/54))
- macOS build and install. `build.sh` builds Lys from a source checkout and
  installs `Lys.app` in `/Applications`, plus the bundled backend and a private
  Node.js runtime in `$LYS_HOME/runtime`. Release builds of the app start the
  backend from that runtime. ([#55](https://github.com/w3lt/lys/pull/55),
  [#58](https://github.com/w3lt/lys/pull/58))
- The backend starts when LM Studio is not running. The desktop app reports the
  backend and LM Studio separately, and **Refresh** connects once LM Studio is
  available, without relaunching Lys. The backend adds
  `GET /api/v1/llm/runtime` and `POST /api/v1/llm/runtime/connect`.
  ([#83](https://github.com/w3lt/lys/pull/83))
- Replies render math with KaTeX and highlight code blocks with Shiki.
- The empty conversation view shows Lys's framed portrait.
  ([#104](https://github.com/w3lt/lys/pull/104))
- The root `VERSION` file holds the release version.
  `pnpm --filter @lys/scripts run version:sync` writes it into every manifest,
  and `version:check` reports manifests that differ.
  ([#58](https://github.com/w3lt/lys/pull/58))
- A backend unit test suite that runs without LM Studio, network access, or
  `LYS_HOME`: `pnpm --filter @lys/backend test`.
  ([#79](https://github.com/w3lt/lys/pull/79))

### Changed

- The backend owns each reply from start to finish. Closing a chat stream stops
  only that client's view of the reply; **Stop** and backend shutdown are the
  only ways to end it. Opening a conversation whose reply is still generating
  follows that reply live. The backend adds
  `GET /api/v1/chat/:conversationId/replies/:assistantMessageId/events` and
  `POST /api/v1/chat/:conversationId/replies/:assistantMessageId/stop`.
  ([#91](https://github.com/w3lt/lys/pull/91))
- History search sends its request 200 ms after the last keystroke instead of
  on every keystroke. ([#93](https://github.com/w3lt/lys/pull/93))
- SQLite runs in write-ahead logging mode with `synchronous=NORMAL`, which lowers
  the cost of storing each streamed reply delta.
  ([#91](https://github.com/w3lt/lys/pull/91))
- New application icons.

### Fixed

- **Stop** is available in every phase of an active request: while the reply is
  awaited, while it streams, and after it completes.
  ([#40](https://github.com/w3lt/lys/pull/40))
- A new conversation no longer shows a chat error when the title reply arrives
  as JSON inside a Markdown code fence. A title failure is never reported as a
  chat failure, an untitled conversation retries its title on later turns, and
  a saved title is no longer replaced by later turns.
  ([#46](https://github.com/w3lt/lys/pull/46))
- Messages are sent with the model shown in the Composer instead of a fixed
  model, and sending is refused with a message pointing to Settings → Model when
  no model is loaded. ([#41](https://github.com/w3lt/lys/pull/41))
- The backend accepts requests from the packaged desktop app's origin.
  ([#51](https://github.com/w3lt/lys/pull/51))
- The desktop host and the backend honor `LYS_HOME` for the settings file, the
  database, and the installed runtime. An app opened from Finder or the Dock
  still uses `~/.lys`, because it does not inherit a shell-profile `LYS_HOME`.
  ([#82](https://github.com/w3lt/lys/pull/82))
- Switching or starting a conversation no longer interrupts a streaming reply or
  drops its pending title. ([#91](https://github.com/w3lt/lys/pull/91))
- **Send** is available as soon as a reply is complete, even while its title is
  still being generated. ([#98](https://github.com/w3lt/lys/pull/98))

### Security

- `fastify` 5.12.5 and `fast-uri` 4.2.1 fix known vulnerabilities in the
  earlier versions.
- pnpm installs a dependency version only after it has been published for at
  least three days.

[0.3.0]: https://github.com/w3lt/lys/compare/v0.2.0...v0.3.0
