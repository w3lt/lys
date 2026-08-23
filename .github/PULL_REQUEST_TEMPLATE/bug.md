<!--
Use this template for existing behavior that prevents Lys from operating according to its intended logic, whether or not a user observes it.
Keep this pull request focused on one primary Bug issue. Replace instructional text with concrete information, and do not include sensitive data.
-->

## Primary issue

<!--
Use "Closes #123" only when this pull request fully fixes the issue.
Otherwise use "Relates to #123". List secondary related issues without closing keywords.
-->

Closes #

## Change type

Bug

## Purpose and need

<!-- What incorrect logic does this change correct, and why is the correction needed? User visibility is not required. -->

## Affected behavior

### Incorrect behavior

<!-- What did Lys do before this fix? -->

### Intended logic or invariant

<!-- What should Lys do, and which rule, contract, or invariant establishes that behavior? -->

## Root cause

<!-- Explain the underlying defect rather than only its visible symptom. -->

## Scope

### In scope

-

### Out of scope

-

## Fix approach

<!-- Summarize how the change addresses the root cause. Explain non-obvious decisions and constraints. -->

## Changes

-

## Regression evidence

<!--
Record the same test or demonstration before and after the fix.
If an automated regression test is not practical, explain why and provide exact manual evidence.
-->

| Test or demonstration           | Before fix             | After fix              |
| ------------------------------- | ---------------------- | ---------------------- |
| `exact command or manual check` | Failed — actual result | Passed — actual result |

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

<!-- What documentation or JSDoc changed? If none, explain why none was needed. -->

## Author checklist

- [ ] This pull request has one clear purpose and one primary Bug issue.
- [ ] The change restores intended logic rather than introducing an unclassified behavior request.
- [ ] The fix addresses the root cause rather than only its visible symptom.
- [ ] The regression evidence demonstrates the defect before the fix and the corrected behavior after it.
- [ ] An automated regression test is included where practical, or the reason and manual evidence are recorded above.
- [ ] Affected callers, consumers, contracts, types, schemas, tests, and documentation remain consistent.
- [ ] Relevant success, failure, boundary, cancellation, and cleanup paths are tested.
- [ ] Validation results above are current and include reasons for relevant checks not run.
- [ ] No unrelated changes, placeholders, debug output, disabled checks, or sensitive data remain.
- [ ] Any breaking change includes the required compatibility or migration work, or no breaking change is present.
