<!--
Use this template for a capability that did not previously exist in Lys, regardless of who or what will use it.
Keep this pull request focused on one primary Feature issue. Replace instructional text with concrete information, and do not include sensitive data.
-->

## Primary issue

<!--
Use "Closes #123" only when this pull request fully delivers the requested capability.
Otherwise use "Relates to #123". List secondary related issues without closing keywords.
-->

Closes #

## Change type

Feature

## Purpose and need

<!-- What goal, workflow, or need does this capability address, and why is it valuable? -->

## Beneficiaries

<!-- Who or what can use or benefit from this capability? -->

## New capability

### Previous limitation

<!-- What was not possible in Lys before this change? -->

### Delivered capability

<!-- What can Lys do now? -->

### Observable outcome or contract

<!-- What observable behavior or contract demonstrates that the capability works? -->

## Scope

### In scope

-

### Out of scope

-

## Implementation approach

<!-- Summarize the approach, including important integration points, data flow, contracts, and non-obvious decisions. -->

## Changes

-

## Deviations from the issue or approved design

<!-- Write "None — implemented as agreed" or explain each deviation and where it was approved. -->

## Acceptance evidence

<!-- Map every agreed success criterion to an exact automated test or manual demonstration and its actual result. -->

| Success criterion  | Test or demonstration           | Result                              |
| ------------------ | ------------------------------- | ----------------------------------- |
| Describe criterion | `exact command or manual check` | Passed, failed, or not run — reason |

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
- Dependencies and rollout:

## Documentation

<!-- What internal or external documentation and JSDoc changed? If none, explain why none was needed. -->

## Author checklist

- [ ] This pull request has one clear purpose and one primary Feature issue.
- [ ] The delivered capability did not previously exist in Lys; a change to an existing capability belongs under Improvement.
- [ ] The delivered capability and observable outcome match the issue and approved design, or every deviation is recorded above.
- [ ] Every agreed success criterion has current acceptance evidence.
- [ ] Affected callers, consumers, integrations, contracts, types, schemas, tests, and documentation remain consistent.
- [ ] Relevant success, rejection, malformed-input, failure, boundary, cancellation, and cleanup paths are tested.
- [ ] Validation results above are current and include reasons for relevant checks not run.
- [ ] No unrelated changes, placeholders, debug output, disabled checks, or sensitive data remain.
- [ ] Any breaking change includes the required compatibility or migration work, or no breaking change is present.
