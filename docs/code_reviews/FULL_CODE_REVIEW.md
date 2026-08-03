# Full Code Review

This review standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md), which own the normative language and the requirement that each rule has exactly one owning file.

This document defines how a reviewer evaluates an existing area of the codebase independently of any proposed change. It does not define construction rules. Every compliance judgement cites a rule owned by an active item standard.

To review a proposed change before it merges, follow [Merge Request Review](./MR_REVIEW.md).

## Purpose and scope

| Aspect   | Definition                                                            |
| -------- | --------------------------------------------------------------------- |
| Input    | A declared set of files, modules, or packages                         |
| Baseline | Under review. Existing code is the subject, not the trusted reference |
| Legacy   | In scope, separated into live risk and accepted debt                  |
| Output   | A ranked remediation plan. No merge verdict                           |

A full code review answers a different question from a merge request review: is each item in the declared target correct, clear, and compliant on its own, and do the items compose into a coherent whole?

The review proceeds item by item because the repository's standards are organized per construct. Every item has an owning chapter, so every compliance finding lands on a stable rule identifier.

## Reviewer mandate

The reviewer MUST report findings only.

The reviewer MUST NOT modify implementation, tests, configuration, or documentation, and MUST NOT stage, commit, push, or create branches, tags, or pull requests. Corrections are applied by a separate implementation pass.

The reviewer MAY run validation commands, because they observe the code rather than alter its sources.

The reviewer MUST NOT weaken, reinterpret, or waive an active standard to accommodate existing code. Widespread noncompliance is evidence of debt, not justification for it.

If the reviewer authored part of the declared target, the report MUST disclose that in its coverage section.

## Review workflow

The five steps run in order. A later step MUST NOT begin before its predecessor's exit condition holds.

### Step 1 — Declare the target and build the item inventory

The reviewer MUST begin from an explicit target: a named set of files, modules, or packages. The reviewer MUST NOT begin a review whose target is open-ended, such as an instruction to review the codebase, because such a review cannot be completed or verified.

If the declared target is too large to sweep completely, the reviewer MUST state this before reviewing and propose a split into reviewable targets. The reviewer MUST NOT begin a sweep it cannot finish, because an abandoned sweep still produces a report that reads as comprehensive.

The reviewer then enumerates every repository-owned item in the target. Item categories are the active item standards:

| Item      | Standard                                    | Rule prefix |
| --------- | ------------------------------------------- | ----------- |
| Variable  | [Variable](../code_standards/VARIABLE.md)   | `VAR`       |
| Constant  | [Constant](../code_standards/CONSTANT.md)   | `CONST`     |
| Function  | [Function](../code_standards/FUNCTION.md)   | `FUNC`      |
| Type      | [Type](../code_standards/TYPE.md)           | `TYPE`      |
| Interface | [Interface](../code_standards/INTERFACE.md) | `IFACE`     |
| Class     | [Class](../code_standards/CLASS.md)         | `CLASS`     |
| Object    | [Object](../code_standards/OBJECT.md)       | `OBJECT`    |
| Component | [Component](../code_standards/COMPONENT.md) | `COMP`      |

Generated output, vendored code, third-party declarations, and build artifacts are exempt when they are not repository-maintained. The reviewer MUST record every exemption and its reason.

The inventory MUST record the total item count and a deterministic order, by file path and then by declaration order within the file. The inventory is the completion contract for the review: it defines what "nothing left" means in Step 4.

**Exit condition:** the target is declared, the inventory is complete and counted, and exemptions are recorded.

### Step 2 — Review each item

The reviewer takes each item in inventory order and assesses it on two axes.

**Logical correctness.** Does the item do what its name and declared contract claim, on every path? The reviewer examines branches, boundary and empty values, error paths, invariants across state transitions, resource acquisition and release, cancellation and ordering where the item is asynchronous, and trust boundaries where the item handles external input.

**Code quality.** Does the item satisfy the triggered rules of its owning item standard, cited by identifier? Repository-owned JavaScript and TypeScript declarations MUST also satisfy the [JSDoc Standard](../JSDOC.md).

The item is judged together with its declared contract, meaning its signature, types, and documentation, and with the tests that exercise it. The reviewer MAY read callers to establish what the contract is, but the verdict is about the item, not about its callers.

An item whose construct has no active standard is still reviewed for logical correctness and clarity. Its quality findings MUST cite the foundation in [Code Construction Rules](../CODE_STANDARDS.md) or the requirements in [Contributing to Lys](../../CONTRIBUTING.md). The reviewer MUST NOT cite an identifier from the deferred registry.

**Exit condition:** the item has been assessed on both axes.

### Step 3 — Record the item verdict

Every item receives exactly one verdict.

| Verdict       | Meaning                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| **Compliant** | The item is correct and satisfies every triggered rule of its standard.                                        |
| **Defective** | The item violates an active rule, or produces an incorrect result on a reachable path.                         |
| **Unclear**   | The reviewer cannot determine whether the item is correct from the item, its declared contract, and its tests. |

An **Unclear** verdict MUST be recorded as a code-quality defect against the item. It MUST NOT be skipped, deferred, or resolved by assuming the item is correct.

This is the defining rule of the item sweep: if correctness cannot be established from the item and its contract without reconstructing intent from unrelated code, the opacity is itself the defect. The construct has failed to express its own contract, which is what makes it unreviewable, unmaintainable, and unsafe to change.

For every Unclear item the reviewer MUST state which correction would make it determinable: a more precise name, a decomposition into smaller items, a more precise type, an explicit contract in documentation, or a test that pins the intended behavior.

The reviewer MUST NOT leave an enumerated item without a recorded verdict.

**Exit condition:** the item has a recorded verdict, and any Defective or Unclear verdict has a candidate finding.

### Step 4 — Complete the sweep, then review composition

The reviewer repeats Steps 2 and 3 in inventory order until every enumerated item has a verdict.

If the sweep cannot be completed, the reviewer MUST record exactly which items were not reached. The reviewer MUST NOT present a partial sweep as a complete one.

The reviewer then performs a composition pass over the same target. An item sweep is structurally blind to defects that live between items, and those are usually the expensive ones. Every item can be individually compliant while the assembly is wrong.

The composition pass examines:

- Responsibilities duplicated or split across items that should be owned once.
- Boundaries that leak, and ownership that is unclear between items.
- Error handling strategies that are inconsistent across the target.
- The same domain concept represented by contradictory contracts or types.
- Dependency direction that inverts the intended layering, or cycles between items.
- Behavior that no item owns, so it is implemented incidentally by several.

A composition finding MUST reference every participating item.

**Exit condition:** every enumerated item has a verdict, unreached items are recorded, and the composition pass is complete.

### Step 5 — Verify, rank, and report

Before a candidate finding may enter the report, the reviewer MUST confirm all of the following:

1. The cited location exists in the current file and contains what the finding claims.
2. Any cited rule identifier exists in an active item standard. Identifiers from the deferred registry are not citable as rules.
3. The described failure is reachable through a real execution path.
4. The stated correction is the smallest one that resolves the defect.

A candidate that fails any of these MUST be moved to **Unverified questions** or dropped. The reviewer MUST NOT report an unverified suspicion as a finding.

The reviewer then runs the validation relevant to the target, records each command and its actual result, and records every relevant check that was not run together with the reason. The reviewer MUST NOT claim that a check passed without current output from that check.

Findings are then ranked into a remediation plan and the report is written.

The report MUST be concise. It MUST NOT restate what the code does, narrate the review process, or catalogue compliant items individually beyond their count.

**Exit condition:** every reported finding passed verification, coverage is disclosed, and the remediation plan is ordered.

## Severity and ranking

Severity is derived from the consequence of the defect, not from the reviewer's confidence in it.

| Severity      | Meaning                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Critical**  | A live risk requiring immediate remediation: data loss or corruption, a security vulnerability, a crash, hang, or deadlock on a reachable path, a silently incorrect result, or an exposed secret.           |
| **Important** | A defect that must be corrected but carries no immediate operational risk: a violated MUST rule, an unhandled reachable error path, an untested behavior path, an Unclear item, or a contract inconsistency. |
| **Minor**     | A violated SHOULD rule without a stated technical reason, or a naming, clarity, or documentation improvement within an otherwise compliant item.                                                             |

No severity blocks a merge, because a full code review is not a merge gate. Severity drives remediation order instead.

The remediation plan MUST be ordered by severity first, then by dependency so that shared contracts and types are corrected before their consumers, and then by effort so that low-cost corrections are not stranded behind large ones.

Noncompliance that the reviewer judges acceptable to leave in place MUST be reported under **Accepted debt** rather than omitted, with the reason it is not scheduled. Silence about known debt is indistinguishable from failure to find it.

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
- Cite a rule identifier from the deferred registry.
- Split one defect across several findings, or merge distinct defects into one.

When many items share one defect, the reviewer MUST report the pattern once with representative locations and a total count, rather than repeating the finding per item.

## Report format

```md
# Full code review — <target>

## Coverage

- Target: <declared files, modules, or packages>
- Items enumerated: 148
- Items reviewed: 148
- Not reached: none
- Exempt: <generated or vendored sources, with reason>

<Disclose here if the reviewer authored part of the target.>

## Assessment

Compliant: 121 · Defective: 19 · Unclear: 8

Critical: 1 · Important: 15 · Minor: 4

<One or two sentences on the overall condition of the target.>

## Critical findings

### C-1 — <one-line defect statement>

References:

- `path/to/file.ts:120` (`FUNC-003`)

<Evidence: the cited rule, or the inputs and state that produce a wrong result.>

Required correction: <smallest change that resolves the defect>

## Important findings

### I-1 — <one-line defect statement>

## Unclear items

### I-4 — `createConversationCommand` cannot be judged from its contract

References:

- `path/to/file.ts:64`

<Why correctness cannot be determined from the item and its contract.>

Required correction: <naming, decomposition, typing, documentation, or test>

## Composition findings

### I-6 — <defect spanning several items>

Participating items:

- `path/to/a.ts:12`
- `path/to/b.ts:80`

## Minor findings

### M-1 — <one-line defect statement>

## Accepted debt

<Known noncompliance not scheduled for correction, and why.>

## Fresh validation performed

- `pnpm exec eslint .`: passed
- `pnpm --filter @lys/desktop test`: not run — <reason>

## Unverified questions

1. <Suspicion that could not be confirmed, and what would settle it.>

## Remediation plan

1. <Ordered corrections, severity first, then dependency, then effort.>
```

Sections with no content are written as `None.` rather than omitted, so a reader can distinguish an empty category from a skipped one.

## Resuming an incomplete review

A sweep that spans several sessions MUST carry its inventory and its recorded verdicts forward, so that a resumed review continues in inventory order rather than restarting or sampling.

A report produced from an incomplete sweep MUST state the reviewed and unreached counts in its coverage section, and MUST NOT present its remediation plan as covering the whole target.

## Reviewer checklist

- [ ] The target was declared explicitly, and was small enough to sweep completely.
- [ ] Every repository-owned item in the target was enumerated, counted, and ordered deterministically.
- [ ] Exemptions were recorded with reasons.
- [ ] Every item was assessed for both logical correctness and code quality.
- [ ] Every item has exactly one recorded verdict.
- [ ] Every Unclear item was recorded as a defect with the correction that would make it determinable.
- [ ] The sweep reached every enumerated item, or the unreached items are named in the report.
- [ ] The composition pass was performed, and its findings reference every participating item.
- [ ] Every reported finding passed the verification gate.
- [ ] No finding cites a deferred rule identifier or reports a preference as a defect.
- [ ] Repeated defects were reported once as a pattern with a count.
- [ ] Coverage is disclosed, and the remediation plan is ordered by severity, dependency, then effort.
