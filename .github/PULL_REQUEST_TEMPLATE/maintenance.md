<!--
Use this template for internal engineering or operational work that preserves Lys's intended observable behavior while keeping the project healthy.
Keep this pull request focused on one primary Maintenance issue. Replace instructional text with concrete information, and do not include sensitive data.
-->

## Primary issue

<!--
Use "Closes #123" only when this pull request fully completes the maintenance objective.
Otherwise use "Relates to #123". List secondary related issues without closing keywords.
-->

Closes #

## Change type

Maintenance

## Maintenance category

<!-- Select every category that applies. -->

- [ ] Refactoring or code health
- [ ] Dependencies or toolchain
- [ ] Build, CI, or release process
- [ ] Test infrastructure
- [ ] Repository cleanup
- [ ] Preventive security hardening
- [ ] Other:

## Current state and rationale

<!-- What internal condition, technical debt, risk, dependency, or process concern made this work necessary? -->

## Maintenance objective

<!-- What internal engineering or operational outcome does this change deliver? -->

## Behavior-preservation requirements

<!-- Identify the intended observable behavior, contracts, data, and compatibility that must remain unchanged. -->

- Intended observable behavior:
- Contracts and integrations:
- Stored data and schemas:
- Configuration and compatibility:

## Scope

### In scope

-

### Out of scope

-

## Implementation approach

<!-- Summarize the approach, including important constraints, sequencing, and non-obvious decisions. -->

## Changes

-

## Deviations from the issue or approved design

<!-- Write "None — implemented as agreed" or explain each deviation and where it was approved. -->

## Completion evidence

<!-- Demonstrate that each internal maintenance objective was achieved. -->

| Objective          | Check or measurement                          | Result                              |
| ------------------ | --------------------------------------------- | ----------------------------------- |
| Describe objective | `exact command, measurement, or manual check` | Passed, failed, or not run — reason |

## Behavior-preservation evidence

<!-- Demonstrate that every applicable behavior-preservation requirement remains satisfied. -->

| Behavior or contract        | Validation                      | Result                              |
| --------------------------- | ------------------------------- | ----------------------------------- |
| Describe preserved behavior | `exact command or manual check` | Passed, failed, or not run — reason |

## Validation

<!-- Record other relevant commands or manual checks and their actual results. Include every relevant check not run and the reason. -->

| Check                     | Result                              |
| ------------------------- | ----------------------------------- |
| `command or manual check` | Passed, failed, or not run — reason |

## Impact and risk

<!-- Write "None — <reason>" when an area does not apply. -->

- Compatibility and migration:
- Persistence, schemas, and configuration:
- Security and privacy:
- Resources, lifecycle, and concurrency:
- Dependencies, licensing, and supply chain:
- Rollout and reversibility:

## Documentation

<!-- What internal or external documentation and JSDoc changed? If none, explain why none was needed. -->

## Author checklist

- [ ] This pull request has one clear purpose and one primary Maintenance issue.
- [ ] The change delivers an internal engineering or operational objective without an intended observable behavior change.
- [ ] Every applicable behavior-preservation requirement has current evidence.
- [ ] The delivered outcome matches the issue and approved design, or every deviation is recorded above.
- [ ] Dependency or toolchain changes were reviewed for compatibility, security, licensing, and platform support where applicable.
- [ ] Affected callers, consumers, integrations, contracts, types, schemas, tests, configuration, and documentation remain consistent.
- [ ] Relevant success, failure, boundary, cancellation, and cleanup paths are tested.
- [ ] Validation results above are current and include reasons for relevant checks not run.
- [ ] No unrelated changes, placeholders, debug output, disabled checks, or sensitive data remain.
- [ ] Any breaking change includes the required compatibility or migration work, or no breaking change is present.
