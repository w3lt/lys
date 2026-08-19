<!--
Use this template when an existing Lys capability already behaves according to its intended logic but should produce a better observable outcome.
Keep this pull request focused on one primary Improvement issue. Replace instructional text with concrete information, and do not include sensitive data.
-->

## Primary issue

<!--
Use "Closes #123" only when this pull request fully delivers the agreed improvement.
Otherwise use "Relates to #123". List secondary related issues without closing keywords.
-->

Closes #

## Change type

Improvement

## Purpose and beneficiaries

<!-- What need or opportunity does this improvement address, and who or what benefits? -->

## Improvement dimension

<!-- Identify the observable dimension being improved, such as usability, accessibility, performance, reliability, or quality. -->

## Existing capability

### Current valid behavior

<!-- What could Lys already do, and why was that behavior consistent with its intended logic? -->

### Limitation or opportunity

<!-- Why was the valid existing outcome insufficient, and what could become better? -->

## Delivered improvement

### Improved behavior or outcome

<!-- How does the existing capability now produce a better observable outcome? -->

### Observable success criteria

-

## Scope

### In scope

-

### Out of scope

-

## Implementation approach

<!-- Summarize the approach, including important trade-offs, integration points, contracts, and non-obvious decisions. -->

## Changes

-

## Deviations from the issue or approved design

<!-- Write "None — implemented as agreed" or explain each deviation and where it was approved. -->

## Outcome evidence

<!--
Compare the outcome before and after this change. Include measurements when relevant.
For qualitative improvements, provide an exact test, inspection, screenshot, or manual comparison.
-->

| Outcome or criterion | Before                      | After           | Evidence                        |
| -------------------- | --------------------------- | --------------- | ------------------------------- |
| Describe outcome     | Baseline or previous result | Improved result | `exact command or manual check` |

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

- [ ] This pull request has one clear purpose and one primary Improvement issue.
- [ ] The affected capability existed before this change; a capability that did not exist belongs under Feature.
- [ ] The previous behavior followed its intended logic; incorrect behavior belongs under Bug.
- [ ] This change intentionally improves an observable outcome; work that preserves observable behavior belongs under Maintenance.
- [ ] The delivered outcome matches the issue and approved design, or every deviation is recorded above.
- [ ] Every agreed success criterion has current evidence, including measurements when relevant.
- [ ] Affected callers, consumers, integrations, contracts, types, schemas, tests, and documentation remain consistent.
- [ ] Relevant success, rejection, malformed-input, failure, boundary, cancellation, and cleanup paths are tested.
- [ ] Validation results above are current and include reasons for relevant checks not run.
- [ ] No unrelated changes, placeholders, debug output, disabled checks, or sensitive data remain.
- [ ] Any breaking change includes the required compatibility or migration work, or no breaking change is present.
