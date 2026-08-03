# Merge Request Review

This review standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md), which own the normative language and the requirement that each rule has exactly one owning file.

This document defines how a reviewer evaluates a proposed change before it merges. It does not define construction rules. Every compliance judgement cites a rule owned by an active item standard.

To review an existing area of the codebase rather than a proposed change, follow [Full Code Review](./FULL_CODE_REVIEW.md).

## Purpose and scope

| Aspect    | Definition                                                     |
| --------- | -------------------------------------------------------------- |
| Input     | A proposed change and its stated intent                        |
| Baseline  | Trusted. The delta and the parts it involves are under review  |
| Untouched | Legacy noncompliance outside the change is not a merge blocker |
| Output    | A merge verdict supported by findings                          |

A merge request review answers one question: does this change achieve its stated purpose without breaking what already works or violating an active standard?

## Reviewer mandate

The reviewer MUST report findings only.

The reviewer MUST NOT modify implementation, tests, configuration, or documentation, and MUST NOT stage, commit, push, or create branches, tags, or pull requests. Corrections are applied by a separate implementation pass.

The reviewer MAY run validation commands, because they observe the change rather than alter its sources.

The reviewer MUST NOT weaken, reinterpret, or waive an active standard to accommodate the change under review. An exception requires the process in [Contributing to Lys](../../CONTRIBUTING.md) and explicit reviewer approval, and MUST NOT be self-approved.

If the reviewer also authored the change under review, the report MUST disclose that in its assessment section.

## Review workflow

The four steps run in order. A later step MUST NOT begin before its predecessor's exit condition holds.

### Step 1 — Establish and verify the merge request context

The reviewer MUST be able to state, from the merge request itself, all of the following:

1. What the change does.
2. Why the change is needed.
3. The intended scope, sufficient to judge whether the touched file set matches it.

Permitted sources are the merge request description, linked issues, commit messages, and specification or plan documents already present in the repository.

When the approach is not obvious from the description alone, the reviewer MUST also be able to state a brief summary of the intended approach.

If any of these cannot be established, or the stated intent is contradicted by the touched file set, the review MUST halt. The reviewer MUST NOT reconstruct intent from the implementation and then review the change against that reconstruction, because doing so validates the code against itself.

A halted review produces a **Blocked — insufficient context** report containing:

- What was established.
- The exact questions for the assigned developer, covering what the change solves, why it is needed, and a brief of the approach when relevant.
- What will be reviewed once those questions are answered.

The reviewer MUST NOT proceed to Step 2 while the review is blocked.

The reviewer MUST also record the exact review boundary as a commit range or file set, so the review is reproducible.

A change SHOULD be returned for splitting when it contains more than one unrelated purpose, because [Contributing to Lys](../../CONTRIBUTING.md) requires a change to have one clear purpose and combined purposes reduce review reliability.

**Exit condition:** the purpose, need, scope, and boundary are recorded and consistent with the touched file set.

### Step 2 — Review the delta

The reviewer examines every added, modified, and removed line within the recorded boundary.

For added and modified code, the reviewer MUST assess:

- **Logic:** whether the change addresses the root requirement rather than a visible symptom, and whether every branch, boundary value, empty and maximal input, error path, retry, cancellation, ordering, and partial-failure path produces a correct result.
- **State and resources:** whether invariants hold at every transition and whether every acquired resource is released on success and failure paths.
- **Compatibility:** whether public APIs, schemas, persisted representations, configuration, and user-facing behavior remain compatible, or whether a required breaking change carries its migration.
- **Security:** whether input trust boundaries, authorization, secret handling, and unsafe casts are correct.
- **Code quality:** whether each added or modified construct satisfies the triggered rules of its active item standard.

For removed code, the reviewer MUST confirm that each removed behavior path is either genuinely obsolete or preserved elsewhere, and that validation, error handling, and tests were not dropped silently. A deletion that quietly removes a behavior path is a defect even when the remaining code compiles and passes.

Step 2 produces candidate findings only. The reviewer MUST NOT verify, classify, or report during this step.

**Exit condition:** every changed line has been assessed for logical correctness and code quality.

### Step 3 — Review the involved parts

The delta shows what changed. It does not show what broke. This step widens the review to the code the change involves.

The involved parts are exactly one hop from the change, not its transitive closure:

- Every changed construct, read as a complete declaration rather than as diff hunks.
- The direct callers and consumers of every changed construct.
- The contracts, types, and schemas the change defines or depends on.
- The tests covering the changed behavior.
- The JSDoc and documentation describing the changed declarations.

The reviewer MUST read the complete files containing the changed constructs. The reviewer MUST NOT judge a construct from diff hunks alone when the repository contains its surrounding contract.

Within the involved parts, the reviewer MUST assess:

- Whether the change and its callers, consumers, contracts, types, schemas, tests, and documentation remain consistent with each other.
- Whether every modified construct complies with its active item standard, per the compliance scope in [Contributing to Lys](../../CONTRIBUTING.md).
- Whether repository-owned JavaScript and TypeScript declarations satisfy the [JSDoc Standard](../JSDOC.md).
- Whether every new or changed behavior path is validated, and whether existing tests were weakened, skipped, or broadly mocked to make the change pass.

Untouched legacy noncompliance discovered in the involved parts MUST be reported as a non-blocking legacy note rather than as a merge blocker, unless the change depends on that defect or makes it worse.

The reviewer then runs validation. Run the smallest relevant checks first, and broader checks when the change affects shared contracts, schemas, configuration, persistence, security, or multiple packages. Applicable commands are listed in [Contributing to Lys](../../CONTRIBUTING.md).

The reviewer MUST record each command and its actual result, MUST NOT claim that a check passed without current output from that check, and MUST record every relevant check that was not run together with the reason.

**Exit condition:** the involved parts have been assessed and the validation record is complete.

### Step 4 — Verify, classify, and report

Before a candidate finding may enter the report, the reviewer MUST confirm all of the following:

1. The cited location exists in the current file and contains what the finding claims.
2. Any cited rule identifier exists in an active item standard. Identifiers from the deferred registry in [Code Construction Rules](../CODE_STANDARDS.md) are not citable as rules.
3. The described failure is reachable through a real execution path.
4. The stated correction is the smallest one that resolves the defect.

A candidate that fails any of these MUST be moved to **Unverified questions** or dropped. The reviewer MUST NOT report an unverified suspicion as a finding.

Surviving findings are then classified by severity, the verdict is derived, and the report is written.

The report MUST be concise. It MUST NOT restate what the code does, narrate the review process, or catalogue correct code beyond the assessment section.

**Exit condition:** every reported finding passed verification and the verdict follows from the severity counts.

## Severity

Severity is derived from the consequence of the defect, not from the reviewer's confidence in it. Uncertainty is expressed by verifying the finding or moving it to unverified questions, never by inflating or deflating its severity.

| Severity      | Blocks merge | Definition                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Critical**  | Yes          | Data loss or corruption, a security vulnerability, a crash, hang, or deadlock on a reachable path, a silently incorrect result, a breaking public API, schema, persisted-data, or configuration change without a migration, a committed secret, or a disabled or weakened check.                                                                 |
| **Important** | Yes          | A violated MUST rule, an unhandled reachable error path, a new or changed behavior path with no test where automation is practical, an inconsistency between implementation and its contract, type, schema, or documentation, an ambiguity that yields opposite review outcomes, or unrelated changes, dead code, placeholders, or debug output. |
| **Minor**     | No           | A violated SHOULD rule without a stated technical reason, or a naming, clarity, or documentation improvement within an otherwise compliant construct.                                                                                                                                                                                            |

The verdict is **Ready** only when there are zero Critical and zero Important findings. Otherwise the verdict is **Not ready**.

## Finding requirements

Every finding MUST contain:

- An identifier of the form `C-1`, `I-1`, or `M-1`.
- A one-line statement of the defect.
- References giving `path:line` for each relevant location, and the rule identifier when the finding is a standards violation.
- Evidence that is either the cited active rule or a concrete failure scenario naming the inputs or state that produce an observably wrong result.
- The smallest correction that resolves the defect.

The reviewer MUST NOT:

- Report a preference as a defect. An alternative the reviewer would have chosen is not a finding unless it violates an active rule or produces an incorrect result.
- Report a defect that has not been confirmed against the current file contents.
- Cite a rule identifier from the deferred registry. A defect in a deferred area is reported against the foundation in [Code Construction Rules](../CODE_STANDARDS.md) or the requirements in [Contributing to Lys](../../CONTRIBUTING.md), and labelled as such.
- Split one defect across several findings, or merge distinct defects into one.

## Report format

```md
# Merge request review — <change name>

## Assessment

**Ready.** | **Not ready.** | **Blocked — insufficient context.**

Critical: 0 · Important: 2 · Minor: 1

<One or two sentences on what the change does and what drives the verdict.
Disclose here if the reviewer also authored the change.>

## Review scope

- Boundary: <commit range or file set>
- Involved parts reviewed: <callers, contracts, tests, documentation>
- Excluded: <what was not reviewed, and why>

## Critical findings

None.

## Important findings

### I-1 — <one-line defect statement>

References:

- `path/to/file.ts:120` (`FUNC-003`)

<Evidence: the cited rule, or the inputs and state that produce a wrong result.>

Required correction: <smallest change that resolves the defect>

## Minor findings

### M-1 — <one-line defect statement>

## Legacy notes

<Non-blocking noncompliance in untouched code within the involved parts.>

## Fresh validation performed

- `pnpm exec eslint .`: passed
- `pnpm --filter @lys/desktop test`: not run — <reason>

## Unverified questions

1. <Suspicion that could not be confirmed, and what would settle it.>

## Required follow-up

1. <Ordered corrections required before merge.>
```

Sections with no content are written as `None.` rather than omitted, so a reader can distinguish an empty category from a skipped one.

## Re-review after fixes

A re-review MUST classify every finding from the previous report as one of:

- **Fixed** — the required correction was applied and verified against the current file.
- **Fixed differently** — an alternative correction resolves the defect. The reviewer MUST verify the alternative rather than accept it on description.
- **Not fixed** — the defect remains. The finding keeps its original identifier.

The reviewer MUST then review the fix diff itself as a new change through Steps 2 to 4, because corrections introduce defects. The reviewer MUST NOT approve based on the author's fix report alone.

## Reviewer checklist

- [ ] The purpose, need, and scope of the change were established from the merge request, not reconstructed from the implementation.
- [ ] The recorded boundary matches the change actually reviewed.
- [ ] Every added, modified, and removed line was assessed for logic and code quality.
- [ ] Removed behavior paths were confirmed obsolete or preserved elsewhere.
- [ ] Changed constructs were read as complete declarations, with their callers and consumers.
- [ ] Every modified construct was checked against the triggered rules of its active item standard.
- [ ] Contracts, types, schemas, tests, and documentation were confirmed consistent with the change.
- [ ] Validation was run and recorded with actual results, including checks that were not run.
- [ ] Every reported finding passed the verification gate.
- [ ] No finding cites a deferred rule identifier or reports a preference as a defect.
- [ ] Severity reflects consequence, and the verdict follows from the counts.
- [ ] The report is concise and free of process narration.
