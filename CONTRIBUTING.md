# Contributing to Lys

Thank you for improving Lys. Every contribution must preserve the codebase's correctness, clarity, testability, security, and long-term maintainability.

This document defines the workflow for human developers. It does not duplicate code-construction rules; those rules live in canonical documents under `docs/` so developer and AI-agent workflows can enforce the same standard.

## Mandatory reading

Before changing code, read and follow:

1. [Code Construction Standards](./docs/CODE_STANDARDS.md) for every repository-owned code construct.
2. [JSDoc Standard](./docs/JSDOC.md) for repository-owned JavaScript and TypeScript declarations in its scope.

The code standards are merge requirements. This workflow cannot be used to waive them.

## Scope of compliance

All new code must comply with the canonical standards. When existing code is modified, the changed construct and its directly affected callers, consumers, contracts, schemas, tests, and documentation must also comply.

Untouched legacy code does not require unrelated cleanup. If a local defect prevents a correct or maintainable implementation, improve the minimum surrounding area required to remove that defect.

Generated output, vendored code, third-party declarations, and build artifacts are exempt when they are not maintained directly. Generators, wrappers, adapters, and integration code remain in scope.

## Before making a change

Before editing, you must:

1. Read the relevant implementation, types, tests, documentation, configuration, and call sites.
2. Trace the affected data and control flow across module, package, process, persistence, and API boundaries.
3. Identify the root requirement or defect rather than treating only its visible symptom.
4. Check for an established repository pattern before introducing a new one.
5. Define the smallest coherent change and the behavior paths that require validation.
6. Identify compatibility, persistence, security, concurrency, resource, and lifecycle risks that apply.

Do not invent requirements, public behavior, APIs, or architectural conventions. Ask for a decision when unresolved ambiguity would materially change behavior, data, compatibility, architecture, or security.

## Making the change

Keep the implementation focused and reviewable.

You must:

- Follow the construct-level standards for every new or modified unit.
- Preserve established architecture, terminology, and conventions unless a targeted improvement is necessary.
- Solve the root cause and keep affected types, callers, consumers, schemas, tests, and documentation consistent.
- Preserve unrelated work already present in the working tree.
- Remove code made obsolete by the change.
- Keep public APIs and stored data backward-compatible unless a breaking change is explicitly required and planned.

You must not:

- Add unrelated refactors, formatting churn, or whole-file rewrites.
- Add speculative abstractions, configuration, extension points, or dependencies.
- Repeat an existing defect merely for superficial consistency.
- Disable or weaken formatting, lint, type, security, test, or build checks.
- Leave placeholder implementations, unexplained TODOs, commented-out code, dead branches, or debug output.
- Hide incomplete behavior behind unsafe casts, empty error handlers, unconditional defaults, excessive mocks, or false-success responses.
- Commit secrets, credentials, tokens, private keys, or sensitive production data.

## Tests

Every new or modified behavior path must be validated, including relevant successful, rejected, malformed, boundary, failure, retry, cancellation, ordering, and cleanup paths.

Automated tests are required whenever they can exercise the behavior reliably. A defect fix should include a regression test that fails for the original defect when practical.

Tests must:

- Assert observable contracts rather than private implementation steps.
- Be deterministic, isolated, and repeatable.
- Control time, randomness, external I/O, and concurrency when they affect the result.
- Use meaningful names and minimal explicit fixtures.
- Cover affected compatibility boundaries.

Tests must not be deleted, skipped, weakened, broadly mocked, or made flaky merely to make an implementation pass.

If a behavior cannot be tested automatically, record the exact manual validation performed and why automation was not practical.

## Validation

Run the smallest relevant checks first, then broader checks when shared code, contracts, configuration, persistence, security, or multiple applications are affected.

Use repository scripts and tool configuration as the source of truth. Current applicable checks include:

```sh
pnpm exec prettier . --check
pnpm exec eslint .
pnpm --filter @lys/desktop test
pnpm --filter @lys/desktop build
pnpm --filter @lys/backend exec tsc --noEmit
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Run only checks relevant to documentation-only changes, but run affected consumer checks for shared types, protocols, schemas, workspace configuration, and package boundaries.

Never claim a check passed without current output from that check. Report any check that was not run, could not run, or failed, including the reason.

## Documentation

Update documentation in the same change as the behavior or contract it describes.

- Keep public and cross-module contracts documented.
- Explain non-obvious constraints, units, defaults, ownership, lifecycle, side effects, cancellation, compatibility, and meaningful errors.
- Record architectural or operational decisions whose reasoning would otherwise be lost.
- Remove or correct stale comments and examples in the affected area.
- Follow [JSDoc Standard](./docs/JSDOC.md) without duplicating TypeScript syntax or narrating implementation details.

Documentation cannot compensate for code that should instead be renamed, decomposed, or modeled more precisely.

## Dependencies and compatibility

A new dependency requires a demonstrated need and consideration of maintenance, security, size, licensing, and platform compatibility. Prefer an existing dependency or platform capability when it provides a clear fit.

Do not introduce a breaking API, schema, persisted-data, configuration, or user-facing behavior change unless the task requires it. A required breaking change must include an explicit migration path and validation of affected consumers.

## Exceptions

An exception is allowed only when an external constraint makes a rule inapplicable or following it would create a demonstrably worse engineering outcome.

Every exception must document:

1. The exact rule being excepted.
2. The technical constraint and supporting evidence.
3. The alternatives considered.
4. The smallest affected scope.
5. The risk and how it is controlled.
6. The removal condition or reason the exception is permanent.

An exception requires explicit reviewer approval. Time pressure, existing noncompliant code, generated code, or a passing happy-path test is not sufficient justification.

## Before requesting review

Reviewers follow [Merge Request Review](./docs/code_reviews/MR_REVIEW.md) for a proposed change, and [Full Code Review](./docs/code_reviews/FULL_CODE_REVIEW.md) when auditing an existing area of the codebase.

Review the complete diff and confirm:

- [ ] The change has one clear purpose and addresses the root requirement or defect.
- [ ] Every new or modified construct follows [Code Construction Standards](./docs/CODE_STANDARDS.md).
- [ ] The implementation follows existing architecture or clearly justifies a targeted improvement.
- [ ] Affected callers, consumers, types, schemas, persisted representations, and documentation remain consistent.
- [ ] Relevant success, failure, boundary, cancellation, and cleanup paths are tested.
- [ ] Formatting, static analysis, type, test, and build checks relevant to the change pass.
- [ ] No unrelated changes, dead code, placeholders, disabled checks, debug output, or sensitive data remain.
- [ ] JSDoc and other documentation match the final behavior.
- [ ] Any exception is narrow, documented, risk-controlled, and explicitly approved.
- [ ] The final diff is understandable without private or hidden context.

Any unchecked applicable item blocks review and merge.
