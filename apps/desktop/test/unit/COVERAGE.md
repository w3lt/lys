# Desktop unit test coverage

This is the coverage inventory of the desktop renderer's unit suite (#132). It maps each repository-owned source module to the boundary its tests exercise, the dependencies the tests control, and what the tests cannot prove. Update it in the same change as the tests it describes.

The suite is delivered in two parts. This inventory covers `src/lib` and `src/app`. Components, hooks that need a renderer, and views (`src/components`, `src/views`, `src/App.tsx`, `src/main.tsx`) follow in the second part. The Rust host belongs to the native suite (#133), and flows through the real app belong to the E2E suite (#134).

## Running the suite

```sh
pnpm --filter @lys/desktop test             # run once
pnpm --filter @lys/desktop run test:watch   # rerun on change
pnpm --filter @lys/desktop exec tsc         # typecheck the renderer and the suite
```

The `Desktop unit tests` workflow (`.github/workflows/desktop-unit-tests.yml`) runs the typecheck and the suite on every pull request and on every push to `main`. Vitest fails a run that finds no test files.

## Environment and substitution

- Tests run in Vitest with jsdom. They need no LM Studio, no running backend, no Tauri runtime, and no developer settings or database.
- **Backend:** `support/backendFake.ts` replaces the global `fetch` with an in-process backend that answers only the routes a case declares. Any other request fails the case. Abort follows the platform `fetch`: an aborted signal rejects before the route runs, a later abort rejects the pending response or errors its body, and the route's body is cancelled. Success bodies come from fixtures validated by the `@lys/protocol` and `@lys/share` schemas. Malformed bodies appear only in cases that test their rejection.
- **Native host:** `support/nativeHostFake.ts` answers Tauri IPC through Tauri's `mockIPC` seam. Any undeclared command fails the case. `test/unit/setup.ts` removes the IPC double and unmounts rendered trees after every case.
- **Stores:**
  - Factories that take their dependencies (`createChatViewStore`, `createConversationHistoryStore`, and the slice factories) receive the real HTTP wrappers over the fake backend, plus in-test providers (backend availability, clock, model, and generation controls).
  - Singleton stores (`useLysStore`, `useAgentStore`, `useToolStore`, `useChatViewStore`) are imported fresh for each case with `vi.resetModules()`. Their state is arranged only through zustand's public `setState`.
  - No repository module is replaced with `vi.mock`, and no production export was added for tests.
- **Time:**
  - Fake timers control `setTimeout`, `Date`, and `performance.now` where a contract depends on them.
  - `AbortSignal.timeout` is not under fake-timer control, so the one-second health-check bound is checked against the real clock (lower bound only).
  - `support/settlement.ts` provides the macrotask barrier, which also works under fake timers, plus settlement readers and controlled promises.

## Harness

| Module                            | Contract                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `setup.ts`                        | jest-dom matchers. After each case: Testing Library cleanup and Tauri `clearMocks`.      |
| `support/backendFake.ts`          | Fake backend over `fetch`, JSON responses, and server-sent event streams a case writes.  |
| `support/nativeHostFake.ts`       | Fake Tauri host over `mockIPC`. Records commands and rejects undeclared ones.            |
| `support/settlement.ts`           | `waitForMicrotasks`, `createSettlementReader`, and `createControlledPromise`.            |
| `support/modelFixtures.ts`        | Schema-valid downloaded models with narrow variation.                                    |
| `support/conversationFixtures.ts` | UUIDv7 identities, messages by lifecycle, conversations, list pages, and problem bodies. |
| `support/agentFixtures.ts`        | Schema-valid agents, list pages, and problem bodies.                                     |
| `support/toolFixtures.ts`         | Schema-valid client tool definitions.                                                    |

## Inventory

Each row names the source module, its test file under `test/unit`, the boundary exercised, and the behaviors the cases cover. The counts are from the run recorded with this change.

### API wrappers

| Source                           | Tests | Boundary and controlled dependencies            | Covered behavior                                                                                                                                                                                                                                                                               |
| -------------------------------- | ----: | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/apis/http/runtime.ts`       |    19 | Fake backend; real clock for the health timeout | Health: answering, body discarded, failure status, transport failure, one-second timeout. Runtime status and connect: every status, request shape, failure status without the body, invalid payload with its cause, non-JSON, cancellation.                                                    |
| `lib/apis/http/models.ts`        |    35 | Fake backend                                    | List, load, unload, health: request shapes, validated results, duplicate or empty keys, media type and status checks, declared problems projected with their detail, mismatched or undeclared problems withheld, the runtime-unavailable mark, path encoding and limits, cancellation.         |
| `lib/apis/http/chat.ts`          |    21 | Fake backend with event streams                 | Chat and reply-event streams: request shape, event order, validation and JSON failures, cancel on early return and abort, declared absence versus an undeclared 404. Stop: stopped, not generating, undeclared statuses, unreachable backend, no cancellation signal.                          |
| `lib/apis/http/conversations.ts` |    26 | Fake backend                                    | List: query string, parameter validation, duplicates, count bounds, media type, failure text without server detail, transport cause, abort. Get, rename, delete: declared outcomes, undeclared 404, identity checks, title trimming and limits, invalid identifiers rejected before a request. |
| `lib/apis/http/agents.ts`        |    29 | Fake backend                                    | List, get, create, update, delete: request shapes, trimmed bodies, derived codes, declared outcomes, undeclared statuses, identity checks, invalid input rejected before a request, cancellation and transport failures.                                                                       |
| `lib/apis/tauri/backend.ts`      |     6 | Fake native host                                | Command names, the status passed through, rejections passed through.                                                                                                                                                                                                                           |
| `lib/apis/tauri/settings.ts`     |     8 | Fake native host                                | Load, save with the `newSettings` argument, resolution after the write, generation merge that keeps the other groups on disk, no write after a failed load.                                                                                                                                    |
| `lib/apis/tauri/tools.ts`        |    17 | Fake native host                                | Read-text-file, find-files, list-tools: argument shapes, declared failures, undeclared rejections kept as the cause, malformed results, invalid input rejected before invoking.                                                                                                                |

### Pure logic

| Source                                              | Tests | Covered behavior                                                                                                                                                                                                                    |
| --------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/utils.ts`                                      |     3 | Tailwind conflict resolution, conditional classes, empty result.                                                                                                                                                                    |
| `lib/models/inventory.ts`                           |     3 | Detail line, missing metadata, decimal gigabytes.                                                                                                                                                                                   |
| `lib/models/lm-studio-connection.ts`                |    22 | Availability for every backend and LM Studio state, labels, meta lines, tones.                                                                                                                                                      |
| `lib/models/model-residency.ts`                     |    47 | Loaded key, eligible chat model, residency tones, row tones, headings, meta lines, settings and composer row tags.                                                                                                                  |
| `lib/hooks/backendRuntime.ts` (formatters)          |    17 | Status labels, tones, uptime format and its boundaries.                                                                                                                                                                             |
| `lib/store/model-runtime.ts`                        |    14 | Transition precedence, preferred default, first-loaded fallback, unknown versus none, transition check.                                                                                                                             |
| `lib/store/agents/agent-draft.ts`                   |    56 | Problems in field order with shared limits after trimming, name collisions (case-insensitive, own name kept, stale list), code checks, code slugging, copy names within the limit and without split surrogate pairs, change checks. |
| `lib/store/chat-view/conversation-transitions.ts`   |    36 | Turn start, title, deltas, terminal states, stored-conversation projection, streaming reply lookup, snapshots, immutability, invalid stored pairings.                                                                               |
| `lib/store/conversation-history/history-entries.ts` |    22 | Query parsing, literal Unicode case-insensitive matching, plain-text excerpts, match windows, ellipses, surrogate-safe cuts.                                                                                                        |
| `lib/store/conversation-history/history-list.ts`    |    19 | Page building, extension without duplicates, pending and settled lists, title update and removal, including identity when nothing changes.                                                                                          |
| `app/state.ts`                                      |     4 | Initial scroll position and the `scrollPositionChanged` action.                                                                                                                                                                     |

### Stores and slices

| Source                                    | Tests | Boundary and controlled dependencies                                                                        | Covered behavior                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/store/generation-settings.ts`        |    11 | Slice in a vanilla store; fake native host with controlled writes                                           | Value equality, saving and saved states, failure without detail, retry, a joined call during a write, coalesced edits saved after the write (after a failure too), one write at a time.                                                                                                      |
| `lib/store/lm-studio-status.ts`           |    12 | Slice in a vanilla store; fake backend; in-test backend switch                                              | Publication and change notification, connect-then-settle, unknown on failure, no request while stopped, supersession and abort, no publication after the backend stops, reset.                                                                                                               |
| `lib/store/model-actions.ts`              |    19 | Slice in a vanilla store; fake backend; in-test availability                                                | One request at a time, transitions, inventory reconciliation after every mutation, combined failure text, the runtime-unavailable path, health observations, the awaited status re-read, release with late results discarded.                                                                |
| `lib/store/backend-readiness.ts`          |     5 | Fake backend and host; fake timers                                                                          | Immediate readiness, 250 ms checks, early exit, 30 s deadline, status read failure.                                                                                                                                                                                                          |
| `lib/store/index.ts` (`useLysStore`)      |    21 | Fresh singleton; fake backend and host; fake timers                                                         | Initial state, view and pane, initialization order and failures, backend start, readiness, unresponsive and exited outcomes, stale readiness after a stop, stop outcomes, uptime, generation autosave, session-only edits, residency re-derivation, LM Studio re-read after a model failure. |
| `lib/store/tools.ts`                      |    12 | Fresh singleton; fake native host                                                                           | Default choice, list read and failure text, joined reads, a new read after settlement, session switches, per-tool choices that keep their other field.                                                                                                                                       |
| `lib/store/agents/index.ts`               |    40 | Fresh singleton; fake backend; application store state via `setState`                                       | Paged list read and its failures, refresh, supersession, editor open, copy, close, draft and code edits, saves and deletions with every outcome, stopped-backend refusals, guards while a change is pending, replacing a list read that could undo a change.                                 |
| `lib/store/conversation-history/index.ts` |    32 | Factory with real wrappers over the fake backend; in-test availability, clock, and chat-view close          | Opening, closing, and reopening, search pause and trimming, Enter in the search, older pages, renames and deletions with every outcome, one change per conversation, saving a title on close, replacing a stale first-page read.                                                             |
| `lib/store/chat-view/index.ts`            |    49 | Factory with real wrappers over the fake backend and event streams; singleton wiring through a fresh import | Sending and admission, streamed events, stops in every phase, reset, opening stored conversations, following a reply that is still generating, closing, and the singleton's model, generation, and backend wiring.                                                                           |

### Modules without runtime tests here

| Source                                                                            | Reason                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/types.ts`, `lib/apis/index.ts`, `lib/apis/tauri/index.ts`                    | Type declarations and unchanged re-exports only.                                                                                                                                                                                    |
| `lib/store/settings.ts`                                                           | Types and the `initialSettingsState` constant. Its use as the store's initial state is checked through `useLysStore`; whether it matches Rust's defaults is a cross-language claim for the native suite (#133).                     |
| `app/content.ts`                                                                  | Constants. `STARTER_PROMPTS` is covered with the starter view in the second part. `DEFAULT_CONFIG` feeds only the unreachable reducer state described below.                                                                        |
| `app/theme.ts` (`useTheme`), `lib/hooks/backendRuntime.ts` (`useBackendUptimeMs`) | Hooks that need a renderer; covered with the components in the second part.                                                                                                                                                         |
| `app/state.ts`, every action except `scrollPositionChanged`                       | Unreachable from production: `App.tsx` is the only dispatcher and sends only `scrollPositionChanged`. Testing the remaining 25 demonstration actions would freeze dead behavior. Removing them is recommended as a separate change. |

## Proof limits

- The fake backend proves how the renderer builds requests and decodes declared responses. It does not prove compatibility with a running backend (#134) or real network behavior beyond the platform `fetch` semantics it reproduces.
- The fake native host proves command names, arguments, and handling of results and rejections. It does not prove the Rust commands' behavior (#133).
- jsdom and the stores' tests observe state, not rendering. Rendered behavior belongs to the component tests in the second part.
- Some ownership checks guard races that the abort path already ends, so mutating them changes nothing observable:
  - In the agent store, the success-path ownership checks for list pages and agent reads. A superseded read is aborted and, with platform `fetch` semantics, settles through the failure path, which is covered.
  - In the chat-view store, the dispatcher's stale-token returns, because the event handlers reject a stale token themselves.
  - In `useLysStore.setSettings`, resetting `generationSave` to idle before the autosave starts, because the autosave immediately replaces it with `saving`.

## Defects found

| Defect                                                                                                                                                  | Resolution                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `updateConversationHistoryEntryTitle` returned a new list object when the renamed entry was not displayed, so list subscribers re-rendered for nothing. | Fixed: the unchanged list is returned, as documented. Covered by `history-list.test.ts`. |
