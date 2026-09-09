# Test and Fixture

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines how tests, fixtures, doubles, harnesses, and validation records provide reliable evidence about the contracts they claim to verify.

## Definition and scope

A **test** arranges stated conditions, exercises a supported boundary, and evaluates an observable result against an expectation. An **oracle** is the independent contract, relation, or expected outcome used to judge that result. A **fixture** supplies the values or environment needed for a scenario. A **harness** owns the setup, controls, observations, and cleanup needed to exercise a boundary.

A **test double** replaces a collaborator within a defined scope. A stub supplies selected outcomes; a spy records interactions; a mock combines substitution with interaction expectations; a fake implements a constrained alternative mechanism. These names do not waive the represented contract. The actual behavior and ownership determine whether a double is a callback, passive value, stateless provider, or stateful Class construct.

A **test run** is one execution of a declared selection in an identified environment. Passed, failed, skipped, cancelled, blocked, and not executed are different outcomes. A test file, dependency, command declaration, coverage report, or successful setup is not itself proof that the intended behavior was exercised.

The rules apply to repository-owned automated tests, test data, fixture builders, shared contract suites, doubles, harnesses, test discovery and configuration, and reported validation evidence. They also apply to property checks, snapshots, benchmarks, and recorded manual verification where those are used to support a correctness or performance claim. Production features whose names contain "test" remain production behavior.

This chapter does not require one test framework, directory layout, test pyramid, assertion count, coverage percentage, browser suite, live service, or test script in every package. Required cases and minimum boundaries remain owned by the standards for the constructs being tested. A static declaration that needs no runtime test under its owner does not acquire one merely because this chapter exists.

Comment construction also follows [Comment](./COMMENT.md). Documentation of test contracts and validation retains the requirements in this chapter.

## Existing rule ownership

Each active standard retains its exact triggers, requirements, and permitted cases. The item chapters own which behavior must be verified; this chapter connects those obligations to the construction and execution of meaningful tests.

| Concern                                                                                  | Authoritative rule or document                                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Observable function paths, stable boundaries, naming, size, callbacks, and documentation | `FUNC-003`, `FUNC-013`, `FUNC-019`, `FUNC-023`, `FUNC-024` in [Function](./FUNCTION.md)                       |
| Complete class contracts, construction, ownership, and undistorted test seams            | `CLASS-038` and `CLASS-039` in [Class](./CLASS.md)                                                            |
| One authoritative domain constant and meaningful boundary values                         | `CONST-005` and `CONST-010` in [Constant](./CONSTANT.md)                                                      |
| Unchanged provider suites, substitutable doubles, and separate test controls             | `IFACE-032` through `IFACE-034` in [Interface](./INTERFACE.md)                                                |
| Domain validity, untrusted input, authoritative types, and proof of refinements          | `TYPE-008`, `TYPE-009`, `TYPE-020`, `TYPE-021` in [Type](./TYPE.md)                                           |
| Semantic assertions, complete valid fixtures, narrow variation, and immutable ownership  | `OBJECT-058` through `OBJECT-060` in [Object](./OBJECT.md)                                                    |
| Rendered behavior, accessibility, component doubles, snapshots, and capable environments | `COMP-168` through `COMP-177` in [Component](./COMPONENT.md)                                                  |
| Hook invocation, shared lifetimes, deferred work, and consumer integration               | `HOOK-040` through `HOOK-044` in [Hook](./HOOK.md)                                                            |
| Production versus verification ownership, exports, imports, and test registration        | `MODULE-007`, `MODULE-008`, `MODULE-029`, `MODULE-048` through `MODULE-050` in [Module and File](./MODULE.md) |
| Actual commands, dependency provisioning, artifacts, and supported selections            | `PKG-047` through `PKG-052` in [Package and Dependency](./PACKAGE.md)                                         |
| Provider boundaries, rejected effects, temporal outcomes, and consumer compatibility     | `API-049` through `API-052` in [API](./API.md)                                                                |
| Failure categories, recovery, compound failures, and safe diagnosis                      | `ERROR-043` through `ERROR-046` in [Error](./ERROR.md)                                                        |
| Message representation, publication, delivery, lifetime, and compatibility               | `EVENT-046` through `EVENT-050` in [Event and Message](./EVENT.md)                                            |
| Controlled execution, cancellation, capacity, streams, and terminal ownership            | `ASYNC-047` through `ASYNC-052` in [Async Task and Stream](./ASYNC.md)                                        |
| Acquisition, borrowing, transfer, release, replacement, and actual protocols             | `RESOURCE-046` through `RESOURCE-050` in [Resource](./RESOURCE.md)                                            |
| Effective configuration, persistence, application timing, and cross-boundary values      | `CONFIG-049` through `CONFIG-052` in [Configuration](./CONFIGURATION.md)                                      |
| Effective schemas, historical fixtures, migration paths, failure, and compatibility      | `SCHEMA-051` through `SCHEMA-055` in [Schema and Migration](./SCHEMA.md)                                      |
| Change validation, regression evidence, exceptions, and declaration documentation        | [Contributing to Lys](../../CONTRIBUTING.md) and [JSDoc Standard](../JSDOC.md)                                |

Test code retains the ordinary construction rules. Descriptive test labels do not add repository-designed function verbs to `FUNC-003` or exempt callbacks from `FUNC-013` and `FUNC-019`. Stateful fakes retain the Class rules; fixture values retain the Type and Object rules. Framework-imposed declarations retain only their existing exceptions. A documentation exemption in JSDoc does not cancel a separate applicable declaration requirement in another active standard.

Test registration allowed by `MODULE-029` does not authorize resource acquisition during import. Production modules must not depend on verification code under `MODULE-007`, and private implementation details must not become public solely for tests. Any necessary exception follows [Contributing to Lys](../../CONTRIBUTING.md).

## Construction process

Before adding or changing a test or fixture:

1. Identify the contract, changed behavior, relevant item rules, and claimed outcome.
2. Select a boundary and environment capable of observing that outcome.
3. Define the expectation independently of the implementation being checked.
4. Select meaningful scenarios and explicit fixture variation.
5. Identify real collaborators, permitted doubles, and their proof limits.
6. Control time, randomness, I/O, concurrency, and shared state where they affect the result.
7. Establish ownership and cleanup before setup can leave obligations behind.
8. Assert the actual outcome, including forbidden effects and failure state where relevant.
9. Confirm discovery, completion, and applicable static checks through supported tooling.
10. Report the executed selection, results, exclusions, and remaining limitations.

## Mandatory rules

### Purpose, scope, and execution contract

### TEST-001 — Every test protects an identified contract

A test MUST identify the behavior or invariant it verifies and the boundary through which that behavior is observable. Its name and assertions MUST make the triggering condition and expected result understandable without reconstructing unrelated tests.

A test MUST NOT exist only to execute lines, construct an object, or obtain a green status. Successful setup or absence of an exception is sufficient only when that is the complete stated contract under test.

### TEST-002 — Coverage follows the owning construct's requirements

Test selection MUST cover the applicable behavior classes and coupled combinations required by the active item standards and Contributing to Lys. A new Test rule MUST NOT be used to replace a stricter component, interface, lifecycle, schema, or other construct-specific boundary.

Independent inputs need not form a Cartesian product when their combinations add no distinct behavior. Equivalence grouping MUST have a contract-based reason and MUST NOT conceal a boundary, variant, or interaction that can change the outcome.

### TEST-003 — The selected boundary can observe the claim

A test MUST exercise the smallest supported boundary that can faithfully establish its claim while satisfying the owning construct's minimum environment. A narrower test may supplement a required integration check but MUST NOT replace it when the narrower environment omits the behavior being claimed.

The test and its report MUST distinguish pure logic, adapter behavior, real host behavior, and external-system guarantees. Type-checking, simulated I/O, and in-memory storage prove only what those environments implement.

### TEST-004 — Expectations have an independent basis

Expected results MUST come from the contract, an independently justified example, a valid reference model, or a meaningful invariant. Copying the production algorithm into the expected-value calculation MUST NOT make the same mistake pass on both sides.

Shared constants and schemas MAY verify consumer consistency. They do not independently protect the historical value of the same constant or the correctness of the shared schema. Compatibility claims require evidence capable of detecting an unintended change to that authority. Independent evidence MUST preserve `CONST-005`'s single authoritative definition; it does not authorize duplicate domain constants in tests.

### TEST-005 — Regression tests detect the actual defect

A regression test MUST reach the defective condition and distinguish the corrected behavior from the failure it protects against. Where practical, verification SHOULD demonstrate that the test rejects the original defect for the intended reason.

A setup error, unrelated exception, compiler failure, or different broken path MUST NOT be counted as that demonstration. The test MUST retain the relevant triggering data and ordering without preserving incidental implementation details or unsafe reproduction against real user data.

### TEST-006 — Each case remains a coherent behavioral scenario

A test case MUST have a clear arrangement, action, and observation. Multiple assertions are appropriate when they establish one outcome or a necessary lifecycle sequence; unrelated scenarios MUST NOT depend on earlier assertions or mutations merely to share setup.

Test bodies and helpers retain Function size, callback, and abstraction requirements. Extraction MUST keep the scenario's meaningful inputs and expected effects visible rather than hide them behind a universal runner or a chain of configurable callbacks.

### TEST-007 — Tests are discovered by the intended execution path

A new or moved test MUST be included by the supported runner, file selection, target, and relevant build or static-check configuration. A command that exits successfully after discovering no intended cases MUST NOT be reported as behavioral coverage.

File names, dependencies, and documentation do not prove discovery. Supported consumer suites may own shared-package coverage under `PKG-047`; empty scripts or duplicate suites MUST NOT be added solely to make manifests uniform.

### TEST-008 — The test environment is an explicit dependency

Tests MUST identify the environment and prerequisites needed for their claim, including relevant runtime, host, capabilities, services, and configuration. Incidental developer-machine state MUST NOT silently supply a required dependency.

Selecting a default production factory MUST NOT accidentally connect a test to a real service or persistent user store. An unavailable required environment MUST be reported as a limitation or failure according to the declared run contract, rather than replaced by a fake and still claimed as integration evidence.

### Fixtures and harness construction

### TEST-009 — Trusted fixtures satisfy their named contract

Trusted fixture values MUST follow `OBJECT-060`: complete valid construction, narrow permitted variation, invariant preservation, and explicit ownership. A type assertion or generic return annotation MUST NOT manufacture validity.

The fixture MUST be valid for the stage at which it enters the test. Raw input, historical representations, normalized values, and ready resource owners MUST remain distinguishable. A fixture for one stage MUST NOT bypass the validation or conversion that the test claims to exercise.

### TEST-010 — Fixture variation explains the scenario

Fixtures MUST contain the smallest meaningful data that can demonstrate the relevant distinction. Values that determine the result MUST be explicit at the case or in a clearly named fixture contract.

Unrelated defaults, large copied records, and hidden automatic identities MUST NOT obscure why a test passes. Two records intended to prove identity, ordering, or filtering MUST differ in the dimension being tested rather than accidentally remain indistinguishable.

### TEST-011 — Fixture ownership prevents interference

Immutable fixture values MAY be shared when their entire reachable graph is safe to share under the Object rules. Mutable fixture state and resource owners MUST have an explicit isolated lifetime for each test or supported shared scope.

Resetting a shared object after a test does not prevent simultaneous tests from interfering with it. A fixture factory MUST NOT return a fresh outer object while silently retaining writable nested aliases, module state, or a resource owned by another case.

### TEST-012 — Invalid-input tests use the untrusted boundary

Malformed-input tests MUST construct the raw representation accepted by the boundary being tested. They MUST NOT create an invalid trusted domain object through unchecked casts, private mutation, or bypassed construction merely to force a branch.

A trusted closed contract does not require fabricated impossible variants. When the claim concerns runtime rejection at an external boundary, the test MUST reach that boundary before asserting rejection; compiler acceptance or a hand-built typed value does not establish decoding behavior.

### TEST-013 — Fixture generation is reproducible where it affects meaning

Time, identifiers, randomness, locale, and ordering used to create fixtures MUST be controlled when they influence the expected outcome. A failing generated case MUST retain enough safe information to reproduce the relevant input and choices.

Generation MUST preserve the semantic distinction under test. A shared incrementing counter or random value MUST NOT make case order significant or create rare accidental equality. Resource names may be uniquely allocated for isolation without becoming the oracle for domain behavior.

### TEST-014 — Historical and recorded fixtures retain provenance

A fixture claiming to represent an older version, external format, or real protocol exchange MUST identify the contract and relevant provenance it represents. Updating it MUST account for the compatibility evidence that update changes.

Historical migration fixtures retain `SCHEMA-052`. Regenerating an old fixture through the current writer MUST NOT erase the incompatibility the test should detect. Recorded examples MUST retain the fields, timing, and relationships needed for their stated purpose without claiming broader coverage than the sample provides.

### TEST-015 — Test data and artifacts remain safe to retain

Fixtures MUST use synthetic or otherwise non-sensitive data with known provenance. Live credentials, personal user data, real settings files, and production database copies MUST NOT become routine test inputs or checked-in artifacts.

Logs, snapshots, recordings, screenshots, failure attachments, and minimized generated cases MUST preserve the same confidentiality boundary. Redacting a visible assertion message alone does not protect a raw payload retained elsewhere. Test cleanup MUST delete only artifacts the test actually owns.

### TEST-016 — Builders expose narrow, explicit variation

A fixture builder MUST serve a cohesive named contract and accept only the variations that its consumers require. Patches and multi-source construction retain `OBJECT-021` through `OBJECT-024` and `OBJECT-060`.

Blind override spreading, arbitrary partial objects, and silent merging MUST NOT turn an invalid or unrelated input into a trusted fixture. Builder defaults MUST be part of its explicit fixture contract. Reuse MUST NOT create a second implementation of the production policy being verified.

### TEST-017 — Harnesses keep setup and tested behavior distinguishable

A harness MUST identify the ready boundary it creates, the controls it exposes, the observations it records, and the obligations it owns. The test's action and expected result MUST remain distinguishable from setup and cleanup.

Setup helpers MUST NOT silently perform the operation under test or satisfy its expected effect before the action occurs. Shared assertion helpers MAY express a named contract, but MUST retain failure attribution and the case-specific inputs needed to diagnose a mismatch.

### Doubles and dependency control

### TEST-018 — Substitution follows an existing supported seam

Tests MUST substitute dependencies through the boundaries permitted by the Function, Interface, Class, Component, and Hook rules. A double alone MUST NOT justify a new production interface, public export, branch, setter, or test-control operation.

Private-member access, unchecked partial mocks, and module substitution prohibited by the owning construct remain prohibited. A concrete test-only control surface may exist under `IFACE-034`, but production consumers must not receive or depend on it.

### TEST-019 — A double's behavior matches its declared role

A double MUST honor the complete contract of the collaborator or narrower consumer-owned capability it represents. Applicable validation, absence, failures, state transitions, ordering, ownership, and completion behavior MUST remain faithful under `IFACE-033`.

An empty result or no-op is valid only when that outcome is permitted for the arranged scenario. Unexpected calls MUST NOT silently succeed when they invalidate the test's assumptions. A double that returns immediately MUST NOT be used to prove behavior requiring a genuinely pending operation.

### TEST-020 — Reusable fakes have contract evidence

Reusable fakes and alternative providers MUST run the unchanged shared suites required by `IFACE-032`, `IFACE-033`, and `COMP-177` where those rules apply. Provider-specific setup may induce supported outcomes without changing the common assertions.

The suite MUST NOT branch on provider identity to forgive a violated shared guarantee. Mechanism-specific failures and host behavior retain their own validation boundary. Two harnesses over the same fake do not establish compatibility with an external implementation they never exercise.

### TEST-021 — Double observations prove only the observed boundary

A recorded call, argument, or count MAY verify an interaction when that interaction is part of the public collaborator contract. It MUST NOT be treated as proof that the collaborator's external effect, persistence, cancellation, or resource release actually completed.

Tests MUST pair interaction evidence with the consumer-visible outcome or owned-state evidence needed for the claim. Private method-call assertions remain prohibited. Exact ordering assertions require a declared ordering guarantee rather than incidental implementation sequence.

### TEST-022 — Fault injection targets a real failure stage

A failure test MUST state which boundary fails and arrange a failure that the tested boundary can actually observe. Input rejection, dependency rejection, failure after a partial effect, and lost acknowledgement MUST remain distinguishable.

Testing an adapter's defense against malformed vendor input may use untrusted vendor representations; a fake claiming to implement a trusted repository interface MUST NOT manufacture an impossible provider outcome. Failure injection MUST preserve the preceding effects needed to reach the intended recovery path.

### TEST-023 — Substitutions have an isolated lifetime

Mocks, spies, patched globals, fake clocks, and module substitutions MUST be scoped to their permitted test lifetime and restored through failure-safe cleanup. Parallel cases MUST NOT observe or replace each other's substitutions.

A runner's automatic restoration may provide this ownership only for state it actually tracks. Module caches, external resources, imported singletons, and callbacks already scheduled by a substitute require their own handling. Restoration MUST NOT be mistaken for completion of work the substitute started.

### Assertions and scenario selection

### TEST-024 — Assertions compare the declared semantic result

Assertions MUST use the equality, identity, ordering, precision, or representation relation required by the contract under `OBJECT-059`. An assertion MUST be sensitive to a meaningful violation of that relation.

Reference equality is appropriate for a promised identity guarantee, not as a substitute for value equality. Unordered results MUST NOT acquire an accidental order requirement. Tolerances and normalized comparisons MUST have a domain reason and MUST NOT erase the defect being checked.

### TEST-025 — Failure assertions reject the right failure

A negative test MUST establish the relevant failure category, boundary, or consequence closely enough to distinguish the expected rejection from an unrelated setup or implementation error. Merely catching any exception MUST NOT make the test pass.

Exact error text is required only when the text is part of the contract. Tests may instead inspect stable codes, types, causes, safe fields, or effects. An assertion failure inside a broad catch MUST NOT be mistaken for the production rejection the case expected.

### TEST-026 — Absence assertions observe the complete relevant interval

When a test claims that an effect did not occur, it MUST observe the boundary after the relevant work has reached the point that establishes the prohibition. Checking a spy before queued work can run does not prove the effect was prevented.

Rejected mutation, disabled interaction, stale completion, and cancellation cases MUST include the applicable late-work window. The observation must remain bounded and controlled; an arbitrary sleep or an instant empty collection is not proof that no forbidden future publication can occur.

### TEST-027 — Related effects and results agree

Where correctness depends on both an outcome and a side effect, tests MUST establish their required relationship. A successful response paired with an unperformed required write, or a rejected request paired with an unauthorized mutation, MUST fail the corresponding test.

Assertions SHOULD identify the meaningful final state and any required intermediate ordering. Checking only a status code, call count, or happy-path payload MUST NOT be presented as complete evidence for a broader contract.

### TEST-028 — Retried observations do not repeat the action

A waiting assertion MUST re-observe the relevant state within a bounded supported mechanism. Its observation callback MUST NOT repeat a click, command, write, or other effect merely because the expected state has not appeared yet.

The test MUST distinguish deliberate retries of the operation from retries of observation. Expected state MUST be read freshly when the wait depends on a changing value. Polling a snapshot captured before the action cannot establish eventual behavior.

### TEST-029 — Snapshots protect a deliberate representation

Snapshots retain the scope and supplemental-evidence requirements of `OBJECT-059` and `COMP-175`. A snapshot MUST protect an intentional stable representation or visual contract and remain small enough to review meaningfully.

Updating snapshots MUST evaluate each changed expectation against the intended behavior. Bulk acceptance of received output MUST NOT serve as correctness review. Generated identifiers, incidental wrappers, secrets, and unstable environment data MUST NOT obscure meaningful differences or make harmless changes look like contract failures.

### TEST-030 — Parameterized cases remain independent and identifiable

Each table-driven or generated case MUST identify its inputs, expected outcome or relation, and relevant scenario. Mutable state MUST be recreated or explicitly owned so one case cannot prepare another's success.

Case registration and asynchronous subcases MUST complete through the runner's supported protocol. Empty case sets, silently discarded cases, or conditional assertions that never execute MUST NOT be counted as coverage. Grouping MUST preserve useful failure attribution rather than hide which boundary failed.

### TEST-031 — Property checks have meaningful generators and oracles

A property test MUST state the domain it generates, the invariant it checks, and the evidence that the oracle is independent of the implementation error it should detect. Constraints and shrinking MUST preserve the validity needed by that property.

Excessive rejection of generated inputs MUST NOT leave the claimed domain untested. Failures MUST retain a reproducible safe seed or minimized case when the tool supports it. Property checks supplement required concrete compatibility and boundary examples; a new property-testing framework is not mandatory.

### TEST-032 — Static assertions exercise the intended compiler contract

A type-level or compile-failure test MUST be included by the actual compiler or analysis path and distinguish the expected accepted or rejected program from unrelated diagnostics. A transpilation-only test run MUST NOT be claimed as type validation.

Suppression directives and unchecked conversions MUST NOT hide the assertion they claim to prove. A negative fixture that no longer fails for its intended reason must be detected. Runtime validity and serialized behavior still require the checks owned by their actual boundary.

### Timing, concurrency, and lifetime

### TEST-033 — The runner owns every required completion

A test MUST await or otherwise register every operation, assertion, callback, subtest, and cleanup completion required for its outcome through the runner's supported protocol. Returning before a rejection or assertion becomes observable MUST NOT produce a passing result.

Started background work MUST retain an owner until its test-scoped obligations end. A completed parent callback does not prove child work completed. Detached asynchronous assertions and unhandled rejections MUST NOT escape into another case or disappear after the runner reports success.

### TEST-034 — Concurrency tests establish the intended interleaving

When order affects correctness, tests MUST use the controlled boundaries required by the Class, Component, Async, and Event rules. The test MUST establish that work reached the relevant point before admitting, replacing, cancelling, or completing competing work.

Starting two promises and awaiting both does not prove they overlapped at the critical transition. Repeated microtask yields or machine-speed assumptions MUST NOT stand in for a named observable barrier. Each tested schedule proves its declared case, not every possible interleaving.

### TEST-035 — Clock control matches the behavior being tested

Tests involving time MUST distinguish the clocks and scheduling mechanisms that affect their contract, including wall time, elapsed time, timers, and asynchronous continuations where relevant. A fake clock MUST control the source the implementation actually samples.

Advancing simulated time does not automatically complete unrelated I/O or prove real scheduler behavior. Assertions MUST account for the required callbacks and publications after the advance. Real elapsed-time measurements belong to an explicitly capable environment when timing itself is the claim.

### TEST-036 — Waiting is bounded and cannot strand the harness

A test that waits for a barrier, callback, external response, or eventual state MUST have a bounded failure path supplied by the runner or harness. A timeout MUST identify unfinished work without falsely claiming it was cancelled or cleaned up.

Failure before a barrier is released MUST NOT leave teardown waiting forever on that barrier. The harness MUST provide the release, cancellation, or isolation mechanism required to end its owned work. Increasing a timeout alone MUST NOT be used to conceal a missing progress or ownership guarantee.

### TEST-037 — Temporal assertions cover the relevant ownership result

Tests for cancellation, queues, streams, retries, or shutdown MUST apply the cases owned by the Async, Event, Resource, and other affected chapters. Assertions MUST observe the relevant pending state, result, capacity, delivery, or release obligation.

Calling an abort function, emptying a local collection, or reaching the end of a reader MUST NOT prove a stronger terminal guarantee. A path without cancellation, replay, pooling, or streaming support need not add that behavior solely to create a test.

### TEST-038 — Setup installs cleanup before later failure can leak ownership

As soon as setup acquires an obligation, the harness MUST protect its cleanup before another fallible step or assertion can abandon it. Partially completed setup MUST retain ownership of every acquired resource and substitution.

Cleanup registered only after all asynchronous setup succeeds does not protect earlier acquisition failures. Runner hooks, lexical disposal, or explicit ownership scopes MAY provide the protection, but their actual failure behavior must be understood. A test's assertion failure MUST NOT bypass required cleanup.

### TEST-039 — Cleanup completes without hiding the primary failure

Teardown MUST attempt every required release through the actual ownership protocol and await required completion. It MUST preserve the primary failure and relevant cleanup failures under the Error rules rather than replace them with a misleading pass or unrelated teardown error.

The harness MUST distinguish resetting local observations from ending timers, listeners, tasks, locks, connections, or external effects. Cleanup failure MUST leave a truthful failed or otherwise explicitly incomplete test result and prevent unsafe reuse by later cases.

### TEST-040 — Shared process state is controlled explicitly

Tests that affect module state, global objects, clocks, randomness, working-directory behavior, caches, or process configuration MUST declare their supported scope and prevent leakage into other tests. An after-hook reset alone is insufficient when concurrent tests can observe the mutation.

Use fresh owners or an appropriately isolated execution boundary where supported. Tests MUST NOT read a developer's real settings, secrets, or incidental environment to construct expected results. Configuration inputs remain subject to their namespace and authority contracts.

### TEST-041 — Parallel execution preserves independence

Tests that can run concurrently MUST have independent mutable state and unambiguous ownership of files, ports, database contents, service namespaces, and other shared resources they use. Cleanup MUST target only the allocation belonging to its case.

Serialization is appropriate when an actual supported shared facility cannot safely run concurrently, but MUST NOT conceal avoidable fixture coupling. A suite MUST NOT depend on file order, worker assignment, or an earlier test's side effects. Allocation and collision handling must use the actual resource boundary.

### Integration and environment limits

### TEST-042 — Boundary tests retain the real translation path

Tests used to verify an API, event, or cross-language representation MUST exercise the actual routing, argument mapping, encoding, validation, or decoding path that owns the claim under the relevant standards. Shared in-process types alone do not establish that boundary.

Provider injection or an in-process request harness MAY be sufficient when it faithfully exercises the affected translation. A live network is required only for guarantees the narrower environment cannot observe. Expected and received representations MUST NOT share an unchecked mistaken assumption.

### TEST-043 — UI and hook tests use their supported host

Component and hook tests MUST retain the rendered-surface, interaction, accessibility, lifecycle, and environment requirements in `COMP-168` through `COMP-177` and `HOOK-040` through `HOOK-044`. Calling a component or hook as an ordinary function cannot prove its renderer contract.

Simulated DOM evidence MUST be described at the level it actually observes. Required real-browser, native, visual, or assistive-technology behavior needs a capable reliable environment or the exact recorded-manual path permitted by its owner.

### TEST-044 — Adapter claims include the mechanism that matters

A fake external client may verify repository policy and input/output mapping, but MUST NOT be reported as evidence of native release behavior, database locking, real transport cancellation, or vendor-version compatibility it does not implement.

When those mechanisms are affected, verification MUST use the actual supported adapter or platform boundary required by the owning standards. Local contract suites remain useful alongside that evidence. A live dependency smoke test alone does not replace deterministic checks of failure and ordering policy.

### TEST-045 — Persistence evidence reaches retained state

Tests claiming storage, migration, or configuration persistence MUST exercise the boundary and postconditions owned by Configuration, Schema, and Resource. Relevant assertions MUST inspect the state available to subsequent reads or openers, not only an acknowledged command.

In-memory storage may verify behavior it faithfully implements. It MUST NOT be presented as proof of file replacement, crash recovery, durable synchronization, or cross-process coordination. Historical fixtures and compatibility paths must remain valid for the version they represent.

### TEST-046 — External test targets are intentional and isolated

A test that performs real filesystem, network, process, or service operations MUST select an explicitly supported test target and retain its authority, cleanup, and data-isolation contracts. Production or personal targets MUST NOT be chosen through accidental defaults.

Provisioning failures MUST remain visible. A missing external prerequisite MUST NOT silently switch to a substitute while retaining the original integration label. Artifacts and external effects left for diagnosis require an explicit owner and retention policy rather than being abandoned as test debris.

### TEST-047 — Performance evidence matches its stated measurement

A performance or resource-use test MUST define the workload, measured quantity, relevant environment, and conditions that influence the result. A comparative claim MUST identify its comparison baseline. Warmup, caching, concurrency, input volume, and measurement variability MUST be controlled or recorded when material.

A threshold MUST protect an actual budget or justified regression criterion. Incidental machine timing MUST NOT become a flaky correctness assertion. Measurements from one environment or a tiny fixture MUST NOT be extrapolated into unsupported capacity or platform claims.

### TEST-048 — Platform selection and missing capabilities remain visible

Conditional tests MUST state the supported environment in which they apply and distinguish an intentionally excluded target from an unavailable prerequisite for a required case. The reported selection MUST retain skipped and unexecuted coverage.

An unsupported platform case may be excluded from a run that does not claim it. A required integration check MUST NOT silently skip because installation, credentials, or a service failed. Conditional selection MUST NOT turn missing capability into proof that the corresponding contract passed.

### Results, maintenance, and evidence

### TEST-049 — Reported outcomes reflect actual execution

Passed, failed, skipped, cancelled, blocked, expected failure, and not executed MUST remain distinguishable. A cancelled run or an allowed failing case MUST NOT be counted as successfully verified behavior.

Any maintained expected-failure case MUST identify the precise known defect and detect when that expectation no longer holds. Such tracking does not waive a required check or replace the repository exception process. Empty test bodies, always-true assertions, and success handlers that swallow failures are prohibited.

### TEST-050 — Retries do not erase instability

A failing run followed by a passing retry MUST retain both outcomes when reporting reliability. Retrying until green, adding arbitrary sleeps, loosening assertions, or serializing unrelated tests MUST NOT replace investigation of the failure's cause.

Retries used to test a production retry contract are separate from retries of the test runner. Required checks MUST NOT be skipped, quarantined, or weakened merely to make the suite pass. A temporary exception retains the narrow documented process and required reviewer approval in Contributing to Lys.

### TEST-051 — Validation commands prove their intended selection

Commands MUST come from current repository scripts or supported tooling under the Package rules. The validation owner MUST verify the selected tests, exit status, and completion rather than infer execution from a command name or configuration file.

Discovery, compilation, lint, test execution, build, and artifact consumption establish different facts. Pipeline wrappers, caches, filters, and optional-command behavior MUST NOT hide a failed or omitted stage. A cached result is evidence only for the inputs and environment it verifiably represents.

### TEST-052 — The validation record states what was actually verified

A completion report MUST identify the relevant commands or procedures, tested scope, results, and material environment limits. Every required check that failed, did not finish, or could not run MUST include the exact reason and unverified boundary.

Recorded manual checks MUST state the environment, actions, expected result, observed result, and why reliable supported automation was unavailable when the owning standard requires that justification. A plan, source inspection, or earlier result MUST NOT be reported as fresh successful execution.

### TEST-053 — Test maintenance preserves intended protection

When behavior changes, tests and fixtures MUST be updated to the approved contract while preserving required coverage of unaffected behavior. Removing or replacing a test MUST account for the protection it supplied and any retained compatibility obligation.

An obsolete expectation may be removed when its contract is intentionally removed; a failing expectation MUST NOT be deleted merely because it is inconvenient. Refactoring tests SHOULD reduce duplication and incidental coupling without hiding scenarios in a second framework or reproducing production logic.

### TEST-054 — Coverage metrics support analysis rather than replace it

Coverage reports MUST state their measured scope and exclusions. Executed lines, branches, test counts, snapshots, and a passing quality gate MUST NOT stand in for required behavioral assertions or faithful boundary execution.

A metric may help locate untested behavior, but a high percentage does not establish a valid oracle, complete failure coverage, or absence of races. Existing checks and thresholds MUST NOT be weakened to make a report pass. This chapter creates no universal numerical coverage target.

### TEST-055 — Test support remains maintainable repository code

Test utilities, generators, fakes, fixtures, and harnesses MUST retain their authoritative ownership, dependency boundaries, types, construction rules, and applicable declaration documentation. A test directory is not an exemption for oversized units, hidden state, unsafe casts, or speculative abstractions.

Documentation MUST explain non-obvious fixture meaning, test controls, expected failure, environment needs, and execution limits without narrating obvious assertion syntax. Test labels do not replace required API documentation for named helpers. Production contracts remain in production-owned modules under `MODULE-007`.

## Repository boundary examples

These examples describe assertions and boundaries present in the current working tree. They do not claim that a suite was executed, that the implementation is compliant with this chapter, or that every active requirement is covered. Existing limitations are not exceptions for new or modified code.

| Observed boundary                                                                                                                       | Test and fixture distinction                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A load-route test registers the real route, injects a request, and supplies a controlled runtime result                                 | The assertions address request handling, response mapping, and delegation; they do not prove a real SDK load or network transport.                                          |
| Invalid unload bodies assert both a rejected status and no keys forwarded to the runtime                                                | Rejection and prevention of the protected effect are separate observations that must agree.                                                                                 |
| Request paths and methods are read from the shared protocol descriptor                                                                  | This can prove consumer consistency, but cannot independently detect an unintended change to the same shared external path.                                                 |
| Stop tests use two instances of one model and another unrelated model                                                                   | Distinct instance identities expose filtering and the documented stop ordering; equal-looking fixtures would conceal those differences.                                     |
| A stop rejection followed by empty inventory expects successful reconciliation with diagnostics                                         | A command failure and the final reconciled outcome are different facts; a later external load remains outside that observation.                                             |
| Runtime tests hold one operation with explicit start and release promises                                                               | The harness can exercise selected queue and shutdown interleavings. Its existence does not prove every schedule or failure-safe barrier cleanup.                            |
| Singleton tests use an in-memory database and record reverse-order release and compound failures                                        | Composition ownership is observable; file durability and populated historical migrations require different evidence.                                                        |
| One set of lifecycle assertions is registered against two service harness factories                                                     | Shared assertions protect the common capability contract, while both harnesses' reliance on an in-memory model limits claims about the live vendor.                         |
| Fixtures include immutable model values and deliberately malformed vendor records                                                       | Valid trusted fixtures and deliberately malformed boundary input serve different stages and proof obligations.                                                              |
| Backend test sources exist, but the package manifest declares only a development script and its TypeScript project includes only source | Test files, command discovery, runtime execution, and static checking must each be verified. The current handbook's backend-script claim is not supported by that manifest. |
| The desktop manifest includes a test runner, while repository discovery finds no desktop cases                                          | A dependency or command is not evidence of exercised behavior.                                                                                                              |

The relevant sources are the [load-route tests](../../apps/backend/test/modules/llm/routes/loadModelRoute.test.ts), [unload-route tests](../../apps/backend/test/modules/llm/routes/unloadModelRoute.test.ts), [stop-operation tests](../../apps/backend/test/modules/llm/stopLlmModelsByKey.test.ts), [documented stop contract](../../apps/backend/src/modules/llm/stopLlmModelsByKey.ts), [runtime tests](../../apps/backend/test/di/services/lmStudioLlmRuntime.test.ts), [singleton composition tests](../../apps/backend/test/di/singleton.test.ts), [shared suite registration](../../apps/backend/test/modules/llm/routes/index.test.ts), [service harnesses and fixtures](../../apps/backend/test/modules/llm/routes/llmModelServiceHarness.ts), [backend package manifest](../../apps/backend/package.json), [backend TypeScript project](../../apps/backend/tsconfig.json), [desktop package manifest](../../apps/desktop/package.json), and [current testing guide](../../apps/docs/src/content/docs/develop/testing.mdx).

The backend test directory is untracked in the observed working tree. These source examples establish review boundaries, not a passing run, measured coverage, complete fake conformance, or a supported production-service integration suite.
