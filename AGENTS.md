# Repository Instructions for AI Agents

These instructions apply to every AI agent changing this repository. They define the agent workflow; the canonical construction rules remain in `docs/`.

## Authority

Agents MUST follow:

1. [Contributing to Lys](CONTRIBUTING.md) for the shared repository workflow.
2. [Code Construction Rules](docs/CODE_STANDARDS.md) for mandatory construct-level requirements.
3. Every active item standard linked from `docs/CODE_STANDARDS.md` that applies to a construct being added or modified.
4. [JSDoc Standard](docs/JSDOC.md) for repository-owned JavaScript and TypeScript in its scope.
5. [Merge Request Review](docs/code_reviews/MR_REVIEW.md) or [Full Code Review](docs/code_reviews/FULL_CODE_REVIEW.md) when reviewing code rather than authoring it.

This file MUST NOT be used to redefine or weaken a canonical construction rule. Rule ownership stays with the documents under `docs/`.

A more specific nested `AGENTS.md` MAY add local instructions but MUST NOT weaken this file or an active canonical standard. An exception requires the documented process in `CONTRIBUTING.md` and explicit reviewer approval.

## Mandatory reading before editing

Before changing a file, an agent MUST:

1. Read `CONTRIBUTING.md` and `docs/CODE_STANDARDS.md`.
2. Identify every construct that will be added or modified.
3. Read each applicable active item standard completely.
4. Read `docs/JSDOC.md` before changing repository-owned JavaScript or TypeScript declarations in its scope.
5. Inspect the affected implementation, callers, consumers, contracts, types, tests, configuration, and documentation.
6. Check the working tree and preserve unrelated user changes.

An agent MUST NOT start implementation from an isolated snippet when the repository contains the surrounding contract or convention.

## Compliance scope

All new repository-owned code MUST comply with every applicable active standard.

When existing code is modified, the changed construct and its directly affected callers, consumers, contracts, types, schemas, tests, and documentation MUST also comply.

Untouched legacy code does not require unrelated cleanup. An agent MUST improve the minimum surrounding area necessary when a local defect prevents a correct, compliant, or maintainable change.

Generated output, vendored code, third-party declarations, and build artifacts are exempt when they are not repository-maintained. Generators, adapters, wrappers, and integration code remain in scope.

## Deferred standards

The deferred registry in `docs/CODE_STANDARDS.md` records planned chapters only.

For a deferred item:

- The planned file and prefix are not active.
- Agents MUST NOT create placeholder standard files.
- Agents MUST NOT invent or cite rules under the planned prefix.
- Existing active standards and repository conventions still apply.
- Deferred status MUST NOT be treated as permission for unclear, coupled, unsafe, undocumented, or untested code.

Only an explicitly reviewed and approved ruleset may move a deferred item into the active standards table.

## Required change workflow

### Before implementation

An agent MUST:

1. State the requested outcome and identify the affected behavior and boundaries.
2. Trace the relevant data flow, control flow, ownership, lifecycle, error, and compatibility contracts.
3. Identify the root requirement or defect.
4. Select the smallest coherent change.
5. Identify applicable rule IDs and relevant validation commands.
6. Ask for direction only when unresolved ambiguity would materially change behavior, architecture, data, security, compatibility, or external state.

### During implementation

An agent MUST:

- Keep changes focused on the approved outcome.
- Preserve established architecture and terminology unless a targeted correction is required.
- Keep affected implementation, contracts, types, tests, and documentation consistent.
- Prefer explicit, typed, deterministic, and testable behavior.
- Use SOLID only under the concrete conditions defined by the active standards.
- Remove code made obsolete by the change.
- Preserve backward compatibility unless the task explicitly requires a breaking change and its migration.

An agent MUST NOT:

- Add unrelated refactors or formatting churn.
- Add speculative abstractions, extension points, configuration, or dependencies.
- Hide incomplete behavior with implementation placeholders, unexplained TODOs, unsafe casts, empty handlers, no-op implementations, or false-success results.
- Duplicate a canonical rule in another file.
- Weaken or disable formatting, lint, type, test, security, or build checks.

### Validation

After editing, an agent MUST:

1. Run the smallest relevant checks first.
2. Run broader checks when the change affects shared contracts, schemas, configuration, persistence, security, or multiple packages.
3. Validate documentation formatting, links, examples, and rule references when standards change.
4. Inspect the final diff for unrelated changes, stale documentation, debug output, placeholders, and sensitive data.
5. Report every relevant check that was run and its result.
6. Report any relevant check that could not run, including the exact reason.

An agent MUST NOT claim completion without fresh validation evidence when validation is possible.

## Review and exceptions

Reviews SHOULD cite stable rule IDs rather than paraphrasing requirements.

An agent reviewing a proposed change MUST follow [Merge Request Review](docs/code_reviews/MR_REVIEW.md). An agent reviewing an existing area of the codebase MUST follow [Full Code Review](docs/code_reviews/FULL_CODE_REVIEW.md). A reviewing agent reports findings and MUST NOT apply corrections.

Passing compilation or tests does not override a violated construction rule.

An agent cannot self-approve an exception. Any exception MUST follow `CONTRIBUTING.md`, remain as narrow as possible, and receive explicit reviewer approval.

## Git, safety, and sensitive data

Agents MUST preserve unrelated work already present in the working tree.

Agents MUST NOT create commits, branches, tags, pull requests, or staged changes unless explicitly requested.

Agents MUST NOT perform destructive operations without explicit authorization and verified targets.

Agents MUST treat credentials, tokens, private keys, `.env*` files, production configuration, and user data as sensitive. They MUST NOT read, print, copy, or commit secrets.

## Completion report

The final report MUST state:

- What changed.
- Why it changed.
- Which validation ran and its result.
- Any remaining risk, limitation, deferred work, or required follow-up.

If no risk or follow-up remains, say so explicitly.
