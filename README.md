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
  <a href="https://lys.negentropy.studio"><b>Handbook</b></a> &nbsp;·&nbsp;
  <a href="#quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
  <a href="https://lys.negentropy.studio/architecture/system/"><b>Architecture</b></a> &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md"><b>Contributing</b></a>
</p>

</div>

<img src=".github/assets/divider.svg" alt="" width="100%">

<div align="center">

**Lys is a local-first desktop chat application.**

Your models run on your machine. Your conversations never leave it.<br>
No account, no cloud fallback, no remote surface to expose.

</div>

|                          |                                                                                |
| ------------------------ | ------------------------------------------------------------------------------ |
| **Local-first**          | LM Studio on `127.0.0.1:1234`, SQLite in `~/.lys`. Nothing leaves the machine. |
| **Loopback only**        | The backend binds `127.0.0.1:12345`.                                           |
| **Typed end to end**     | Routes and every stream event are Zod schemas in `@lys/protocol`.              |
| **Streaming by default** | One request, one `text/event-stream`, applied as it arrives.                   |

> [!IMPORTANT]
> Alpha, under active development. A chat turn streams end to end today, but conversation history is not yet restored after relaunch — see [implementation status](https://lys.negentropy.studio/overview/status/).

<img src=".github/assets/divider.svg" alt="" width="100%">

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/turn-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/turn-light.svg">
  <img src=".github/assets/turn-dark.svg" alt="Diagram of one Lys chat turn: the Tauri host starts the backend; the React desktop UI posts to /api/v1/chat; the Fastify backend persists the turn in SQLite, calls LM Studio, and streams typed SSE events back." width="100%">
</picture>

<div align="center">
  <sub>One chat turn, end to end · <a href="https://lys.negentropy.studio/architecture/system/">System overview</a> · <a href="https://lys.negentropy.studio/reference/sse-events/">SSE events</a></sub>
</div>

<img src=".github/assets/divider.svg" alt="" width="100%">

## Quick start

Node 24 · pnpm 11 · Rust · [LM Studio](https://lmstudio.ai) running on `127.0.0.1:1234`

```sh
pnpm install
pnpm dev          # desktop app
pnpm backend:dev  # backend, unless the desktop starts it for you
```

[Environment setup →](https://lys.negentropy.studio/develop/setup/)

<img src=".github/assets/divider.svg" alt="" width="100%">

## Identity

<img src=".github/assets/palette.svg" alt="Lys identity palette: violet-black #080214, violet #AC62FB, cyan #00D0E2, and silver #D2E4F0, with their OKLCH values." width="100%">

<div align="center">
  <sub>Authored in OKLCH. Owned by <code>apps/desktop/src/index.css</code>.</sub>
</div>

<img src=".github/assets/divider.svg" alt="" width="100%">

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Construction rules, the JSDoc standard, and review procedure live in [`docs/`](docs/) — they are merge requirements, not recommendations.

Licensed under the [Mozilla Public License 2.0](LICENSE).

<img src=".github/assets/divider.svg" alt="" width="100%">

<div align="center">
  <sub><b>Lysiptera Caliginia</b> · built by <a href="https://github.com/w3lt">Welt</a> at <a href="https://negentropy.studio">Negentropy Studio</a></sub>
</div>
