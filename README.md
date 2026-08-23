<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/hero-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/hero-light.svg">
  <img src=".github/assets/hero-dark.svg" alt="Lys — Lysiptera Caliginia. Local-first desktop chat: your models, your machine, your data." width="100%">
</picture>

<p>
  <img src="https://img.shields.io/badge/status-alpha-AC62FB?style=flat-square&labelColor=0C031F" alt="Status: alpha">
  <img src="https://img.shields.io/badge/license-MPL--2.0-00D0E2?style=flat-square&labelColor=0C031F" alt="License: MPL-2.0">
  <img src="https://img.shields.io/badge/node-24-4ECA7A?style=flat-square&labelColor=0C031F&logo=nodedotjs&logoColor=4ECA7A" alt="Node 24">
  <img src="https://img.shields.io/badge/pnpm-11.17.0-E7B643?style=flat-square&labelColor=0C031F&logo=pnpm&logoColor=E7B643" alt="pnpm 11.17.0">
  <a href="https://lys.negentropy.studio"><img src="https://img.shields.io/badge/handbook-lys.negentropy.studio-D2E4F0?style=flat-square&labelColor=0C031F&logo=astro&logoColor=D2E4F0" alt="Engineering handbook"></a>
</p>

<p>
  <a href="#quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
  <a href="#anatomy-of-one-chat-turn"><b>How it works</b></a> &nbsp;·&nbsp;
  <a href="#status"><b>Status</b></a> &nbsp;·&nbsp;
  <a href="https://lys.negentropy.studio"><b>Handbook</b></a> &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md"><b>Contributing</b></a>
</p>

</div>

<img src=".github/assets/divider.svg" alt="" width="100%">

## Lys

Lys is a local-first desktop chat application. A Tauri 2 host starts a Fastify backend on your own machine, the backend talks to [LM Studio](https://lmstudio.ai) on loopback for model inventory and completions, and every conversation is written to a SQLite file in your home directory. No prompt is routed through a hosted service, and there is no account to create.

> [!IMPORTANT]
> Lys is alpha software under active development. A chat turn streams end to end today, but conversation history is not yet restored after relaunch. [Status](#status) lists exactly what does and does not work.

|                          |                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local-first**          | Models come from LM Studio on `127.0.0.1:1234`. Conversations live in `~/.lys/lys_db.sqlite`. Nothing leaves the machine.                               |
| **Loopback only**        | The backend binds `127.0.0.1:12345`. There is no remote surface to expose and no cloud fallback.                                                        |
| **Typed contracts**      | Route paths, request bodies, responses, and every stream event variant are Zod schemas in `@lys/protocol`, shared by both sides of the wire.            |
| **Streaming by default** | One chat request opens exactly one `text/event-stream`. The desktop applies typed events as they arrive rather than waiting for a completed message.    |
| **Zero-dependency data** | Persistence uses Node 24's built-in `node:sqlite`. No native database driver, no ORM, no migration framework.                                           |
| **Standards-enforced**   | Construct-level code rules, a JSDoc standard, and review procedures are checked into [`docs/`](docs/) and are merge requirements — not recommendations. |

<img src=".github/assets/divider.svg" alt="" width="100%">

## Anatomy of one chat turn

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/turn-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/turn-light.svg">
  <img src=".github/assets/turn-dark.svg" alt="Diagram of one Lys chat turn: the Tauri host starts the backend; the React desktop UI posts to /api/v1/chat; the Fastify backend persists the turn in SQLite, calls LM Studio, and streams typed SSE events back." width="100%">
</picture>

1. The desktop chat store submits a prompt to `POST /api/v1/chat`.
2. The backend creates or continues a conversation, inserts the user message and an empty assistant row into SQLite, and opens the SSE stream.
3. The backend calls LM Studio through an OpenAI-compatible client and forwards each fragment as a `delta` event.
4. In parallel, the backend asks LM Studio for a conversation title and emits it as a `title` event whenever it is ready.
5. The desktop reads typed events and updates its local presentation state from them.

The desktop never calls LM Studio directly, and the stream is not a shared event bus — events are written straight from the request handler that owns the turn.

<details>
<summary><b>The six stream event variants</b></summary>

<br>

Every payload matches `chatApiStreamEventSchema` in `@lys/protocol`.

| Event                              | Payload                                           | Meaning                                                              |
| ---------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| `start-new-conversation-turn`      | `conversation`, `userMessage`, `assistantMessage` | The backend created a new conversation and persisted the first turn. |
| `start-existing-conversation-turn` | `userMessage`, `assistantMessage`                 | The backend persisted a new turn on an existing conversation.        |
| `title`                            | `title`                                           | A generated title for the active conversation.                       |
| `delta`                            | `content`                                         | One non-empty assistant text fragment.                               |
| `error`                            | `message`                                         | A user-presentable error string.                                     |
| `done`                             | `finishReason`                                    | Successful completion, with `stop` or `length`.                      |

A valid stream begins with exactly one turn-start event, then zero or more `delta` events before `done`. A `title` event may arrive before, during, or after the chat events. Because a title failure does not prevent later chat events, `error` is **not** universally terminal.

Full reference: [SSE events](https://lys.negentropy.studio/reference/sse-events/).

</details>

<img src=".github/assets/divider.svg" alt="" width="100%">

## Quick start

**Prerequisites**

| Tool         | Version                | Why                                                               |
| ------------ | ---------------------- | ----------------------------------------------------------------- |
| Node         | `24` (see `.nvmrc`)    | The backend depends on the built-in `node:sqlite` module.         |
| pnpm         | `11.17.0`              | Pinned by `packageManager` in the root `package.json`.            |
| Rust + Cargo | stable                 | Builds the Tauri host in `apps/desktop/src-tauri`.                |
| LM Studio    | running on port `1234` | Supplies model inventory, model loading, completions, and titles. |

```sh
git clone git@github.com:w3lt/lys.git
cd lys
pnpm install
```

Start LM Studio and load a model, then run the surface you need — these are three separate long-running processes, not one command:

```sh
pnpm dev          # Tauri desktop app (Vite + the Rust shell)
pnpm backend:dev  # Fastify backend in watch mode (tsx)
pnpm docs:dev     # Astro/Starlight engineering handbook
```

The desktop can also start and stop the backend itself through the Tauri host, and does so automatically when `autoStartBackend` is already enabled in `~/.lys/settings.json`.

> [!NOTE]
> Without LM Studio running, the desktop still launches — but model inventory, model loading, chat, and title generation all fail until `127.0.0.1:1234` answers.

## Repository map

```text
lys/
├── apps/
│   ├── desktop/     @lys/desktop    React 19 · Vite 7 · Zustand · Tailwind 4
│   │   └── src-tauri/               Rust host: backend lifecycle, native commands, ~/.lys/settings.json
│   ├── backend/     @lys/backend    Fastify 5 · @fastify/sse · node:sqlite · LM Studio SDK · OpenAI client
│   └── docs/        @lys/docs       Astro 7 · Starlight engineering handbook
├── packages/
│   ├── protocol/    @lys/protocol   Route constants and Zod request, response, and stream-event schemas
│   └── share/       @lys/share      Conversation, message, and metadata models
└── docs/                            Canonical code standards, JSDoc rules, and review procedures
```

## Backend surface

The public protocol is deliberately small and lives entirely under the `@lys/protocol` route definitions.

| Method | Path                | Request body                                                  | Response              |
| ------ | ------------------- | ------------------------------------------------------------- | --------------------- |
| `GET`  | `/api/v1/heath`[^1] | none                                                          | `{ ok: true }`        |
| `GET`  | `/api/v1/llm/list`  | none                                                          | `{ llms: LlmInfo[] }` |
| `POST` | `/api/v1/llm/load`  | `{ modelId: string }`                                         | `LlmInfo`             |
| `POST` | `/api/v1/chat`      | `{ message: string, model: string, conversationId?: uuidv7 }` | `text/event-stream`   |

[^1]: `heath` is the current spelling in both the shared protocol package and the Fastify route registration. It is recorded here as it is, not as it should be.

There is no conversation listing, history retrieval, export, or import endpoint yet, and no typed HTTP error taxonomy beyond route-local thrown errors.

## What Lys writes to disk

| Path                       | Owner           | Contents                                        |
| -------------------------- | --------------- | ----------------------------------------------- |
| `~/.lys/lys_db.sqlite`     | Backend         | Conversation and message rows.                  |
| `~/.lys/settings.json`     | Tauri host      | Runtime settings, including `autoStartBackend`. |
| `lys.theme` (localStorage) | Desktop WebView | Theme preference.                               |

<img src=".github/assets/divider.svg" alt="" width="100%">

## Status

This section describes behavior visible in the repository today. It is not a promise of unreleased work.

**Working today**

- The desktop starts and stops the backend through the Tauri host.
- Health, LLM inventory, and LLM load routes respond.
- A chat turn creates or continues a conversation, persists user and assistant rows, and streams typed SSE events to the desktop.
- The backend generates a conversation title asynchronously and emits it as a stream event.
- The Tauri host reads runtime settings from `~/.lys/settings.json`.

**Not yet**

- Conversation history retrieval or restoration after relaunch.
- Persisted assistant delta content — streamed text currently lives only in desktop state.
- Working Model, Generation, and Conversation settings tabs, and live wiring from those controls into chat requests.
- Replay or reconnect semantics for chat streams.
- Tool-call stream events.
- A production desktop release workflow.
- Evidenced decision, RFC, and release-history records.

## Design language

> Lys identity: darkness, intelligence, modernity, and cold elegance.
>
> — `apps/desktop/src/index.css`

<img src=".github/assets/palette.svg" alt="Lys identity palette: violet-black #080214, violet #AC62FB, cyan #00D0E2, and silver #D2E4F0, with their OKLCH values." width="100%">

Violet-black establishes the dark origin; the cyan aura is its precise, modern counterpart. Colors are authored in OKLCH so both appearances stay perceptually matched. Geometry is a symmetrical soft-square scale — 6px for controls, 10px for surfaces — with capsules and circles reserved for status pills and dots. One restrained ease-out curve, `cubic-bezier(0.32, 0.72, 0.35, 1)`, drives every interaction transition.

The desktop app owns the token set in `apps/desktop/src/index.css`; the handbook carries a verbatim port until a shared `@lys/theme` package exists. Type is Geist and Geist Mono.

<img src=".github/assets/divider.svg" alt="" width="100%">

## Engineering standards

Lys treats construction rules as merge requirements with stable rule identifiers, so reviews cite IDs instead of paraphrasing.

| Document                                                  | Scope                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Code Construction Rules](docs/CODE_STANDARDS.md)         | The canonical manual, plus the per-construct standards and rule prefixes.  |
| [JSDoc Standard](docs/JSDOC.md)                           | Documentation rules for repository-owned JavaScript and TypeScript.        |
| [Merge Request Review](docs/code_reviews/MR_REVIEW.md)    | Procedure for reviewing a proposed change.                                 |
| [Full Code Review](docs/code_reviews/FULL_CODE_REVIEW.md) | Procedure for auditing an existing area of the codebase.                   |
| [Contributing](CONTRIBUTING.md)                           | Workflow, tests, validation, PR templates, and the exception process.      |
| [AGENTS.md](AGENTS.md)                                    | The same authority chain, restated for AI agents changing this repository. |

Passing compilation or tests does not override a violated construction rule, and no one — human or agent — can self-approve an exception.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it defines the required workflow, the test expectations, and the pull-request templates under [`.github/PULL_REQUEST_TEMPLATE`](.github/PULL_REQUEST_TEMPLATE).

<details>
<summary><b>Validation commands</b></summary>

<br>

Run the smallest relevant checks first, then broader checks when shared code, contracts, configuration, persistence, security, or multiple applications are affected.

```sh
pnpm exec prettier . --check
pnpm exec eslint .
pnpm --filter @lys/desktop test
pnpm --filter @lys/desktop build
pnpm --filter @lys/backend exec tsc --noEmit
pnpm --filter @lys/docs run check
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Never claim a check passed without current output from that check.

</details>

## License

Licensed under the [Mozilla Public License 2.0](LICENSE).

<img src=".github/assets/divider.svg" alt="" width="100%">

<div align="center">
  <sub><b>Lysiptera Caliginia</b> · built by <a href="https://github.com/w3lt">Welt</a> at <a href="https://negentropy.studio">Negentropy Studio</a></sub>
</div>
