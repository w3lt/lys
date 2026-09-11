# Error

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines how failures acquire meaning, retain diagnostic evidence, propagate to an owner, and become truthful outcomes for their consumers.

## Definition and scope

An **error** is a represented failure to satisfy an operation's contract or a required invariant. It may appear as a diagnostic exception, a returned failure variant, or another failure channel permitted by the owning contract. The presence of a value named `Error` does not determine its architectural role.

A **failure category** identifies a condition on which a consumer can make a defined decision. A **failure occurrence** is one observed instance of that condition, with context specific to the affected operation. A **diagnostic exception** carries runtime evidence for investigation or propagation; a **failure projection** selects the information a particular consumer is permitted and able to use.

A **cause** explains why another failure occurred. An **aggregate** retains multiple failures that belong to one reported outcome. A causal chain and a group of independent failures express different relationships. Cleanup can fail while handling an earlier operation failure; both occurrences and their roles can matter.

A **failure owner** is responsible for deciding how a failed operation terminates or recovers. A **reporting owner** decides which diagnostic evidence reaches an appropriate observer. Propagating a failure, handling it, presenting it to a user, and logging it are separate actions.

Expected absence, validation rejection, conflict, cancellation, and operational failure are distinct outcomes when the owning contract distinguishes them. They do not all require exceptions. An unknown outcome means that the available evidence cannot establish whether the requested effect occurred; it is not proof of success, failure without effects, or cancellation.

The rules apply to failure representations and their production, translation, handling, recovery, and reporting in repository-owned code. General value construction, callable behavior, object ownership, lifecycle, and transport rules retain their existing owners. This chapter does not prescribe one result wrapper, base exception, class hierarchy, logger, retry framework, or process-wide policy for every operation.

Message meaning and delivery also follow [Event and Message](./EVENT.md); asynchronous execution and stream coordination follow [Async Task and Stream](./ASYNC.md); resource ownership and release follow [Resource](./RESOURCE.md). Configuration contracts also follow [Configuration](./CONFIGURATION.md). Schema contracts and migrations also follow [Schema and Migration](./SCHEMA.md). Tests and fixtures also follow [Test and Fixture](./TEST.md). Comment construction also follows [Comment](./COMMENT.md). Failure documentation retains the requirements in this chapter.

## Existing rule ownership

The following rules retain their exact triggers and permitted cases. Error rules define the additional decisions needed to make a failure path coherent.

| Concern                                                                                  | Authoritative rule or document                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expected outcomes, allowed failure channels, and unexpected-error observability          | `FUNC-009`, `FUNC-010` in [Function](./FUNCTION.md)                                                                                                                                                                                     |
| Trust, side effects, exhaustive branches, async work, resources, and useful wrapping     | `FUNC-007`, `FUNC-011`, `FUNC-015`, `FUNC-017`, `FUNC-018`, `FUNC-021` in [Function](./FUNCTION.md)                                                                                                                                     |
| Closed variants, absence, untrusted values, and validated proof                          | `TYPE-002`, `TYPE-004` through `TYPE-008`, `TYPE-020`, `TYPE-021` in [Type](./TYPE.md)                                                                                                                                                  |
| Value ownership, type category, naming, documentation, and mechanism isolation           | `TYPE-010` through `TYPE-012`, `TYPE-019`, `TYPE-024` in [Type](./TYPE.md)                                                                                                                                                              |
| Failure, cancellation, resource, mutation, and provider-independent capability contracts | `IFACE-015`, `IFACE-018`, `IFACE-020` through `IFACE-022` in [Interface](./INTERFACE.md)                                                                                                                                                |
| Class eligibility, encapsulation, ownership, cleanup, and permitted runtime inheritance  | `CLASS-001`, `CLASS-013`, `CLASS-016`, `CLASS-022`, `CLASS-027` through `CLASS-030` in [Class](./CLASS.md)                                                                                                                              |
| Immutable records and explicit serialized projections                                    | `OBJECT-013` through `OBJECT-016`, `OBJECT-039` through `OBJECT-044` in [Object](./OBJECT.md)                                                                                                                                           |
| Boundary outcomes, safe error details, retries, uncertain effects, and stream completion | `API-017`, `API-021`, `API-026` through `API-031`, `API-034`, `API-035`, `API-037`, `API-043`, `API-044` in [API](./API.md)                                                                                                             |
| Diagnostic correlation at API boundaries                                                 | `API-048` in [API](./API.md)                                                                                                                                                                                                            |
| Component failure states, recovery boundaries, and accessible feedback                   | `COMP-110`, `COMP-129` through `COMP-132`, `COMP-161` in [Component](./COMPONENT.md)                                                                                                                                                    |
| Hook cancellation, ownership, stale completions, and complete outcomes                   | `HOOK-018`, `HOOK-021`, `HOOK-026` through `HOOK-028` in [Hook](./HOOK.md)                                                                                                                                                              |
| Compatibility, documentation, and behavioral verification                                | `FUNC-023`, `FUNC-024`, `TYPE-017`, `IFACE-031`, `IFACE-032`, `CLASS-036` through `CLASS-038`, `API-038` through `API-041`, `API-049` through `API-052`; [JSDoc Standard](../JSDOC.md) and [Contributing to Lys](../../CONTRIBUTING.md) |

An error-specific class is not exempt from the Class standard. A passive failure shape uses the applicable data construct. A domain-specific exception permitted by `FUNC-010` does not itself establish the class eligibility or required external inheritance contract of `CLASS-001` and `CLASS-030`. No repository-designed exception hierarchy is introduced by this chapter.

## Construction process

Before adding or changing a failure path:

1. Identify the affected operation, required invariant, consumer decision, and failure owner.
2. Distinguish expected alternatives, operational failure, defects, cancellation, and uncertainty about completed effects.
3. Select the failure channel already required by the owning callable or capability contract.
4. Identify which evidence proves each category and where external failures enter trusted code.
5. Select category fields, occurrence context, diagnostic causes, and permitted consumer projections.
6. Trace propagation through adapters, concurrent work, cleanup, and terminal boundaries.
7. Establish the conditions for any fallback, retry, reconciliation, or recovery.
8. Identify the resulting resource, lifecycle, persisted, and user-visible states.
9. Assign reporting ownership and assess disclosure, bounded formatting, and reporting failure.
10. Verify the failure decisions and their observable consequences, including relevant compound failures.

## Mandatory rules

### Meaning and representation

### ERROR-001 — A category supports an actual consumer decision

A repository-defined failure category MUST identify a condition that affects handling, recovery, presentation, compatibility, or investigation by an identified consumer.

Categories MUST NOT proliferate solely to mirror every throw site, vendor exception name, or message variation. Conversely, conditions requiring different decisions MUST NOT be collapsed into one indistinguishable failure. An unexpected-failure boundary can use a general category while retaining the original diagnostic evidence.

### ERROR-002 — Classification follows established evidence

A failure MUST be classified using evidence available from the operation's contract, validated response, or trusted runtime condition.

Failure to read a value does not by itself establish that the value is absent. A parse failure does not establish that stored data may be replaced. A rejected request does not by itself establish a user's lack of permission. When the evidence is insufficient, the outcome MUST retain that uncertainty rather than claim a more specific condition.

### ERROR-003 — Failure channels preserve the owning contract

When constructing a failure representation, the choice and consistency requirements of `FUNC-010` MUST be applied to the actual family of equivalent outcomes.

A helper MUST NOT introduce a second competing channel for the same expected condition merely because it calls a throwing dependency. A boundary MAY translate between channels when its consumer has a different explicit contract. That translation MUST preserve the distinctions and evidence the receiving contract requires. No single channel is mandated across unrelated operations.

### ERROR-004 — Ordinary alternatives do not become defects

The failure design MUST distinguish a supported alternative from a violated invariant wherever that distinction changes behavior.

Expected absence, rejected input, conflicts, and requested cancellation MUST retain the meanings established by the owning contract. They MUST NOT become assertions of programming defects simply because an exception represents them. An invariant failure MUST NOT be relabeled as an ordinary alternative merely to fit an existing recovery branch.

### ERROR-005 — Recovery instructions belong to a specific operation

A failure representation MUST NOT advertise an action such as retry, replacement, reauthentication, or destructive reset without evidence that the action is valid for the affected operation and caller.

A category shared across operations does not automatically imply a shared recovery policy. Recovery hints crossing a boundary MUST identify their authority and limitations. The API rules governing retry safety and uncertain effects remain authoritative; a boolean attached to an error does not establish them.

### ERROR-006 — Error abstractions follow the construct they implement

A proposed error abstraction MUST establish whether it is passive data, runtime diagnostic evidence, or a behavioral capability before selecting its construct.

Type, Interface, Class, and Object requirements then apply to that construct. A common suffix or desire to share message formatting MUST NOT justify a base class, inheritance tree, mutable property bag, or speculative registry. Direct extension of an external error base is allowed only under the existing `CLASS-030` conditions.

### Failure values and diagnostic evidence

### ERROR-007 — Failure fields encode the valid condition

Fields in a repository-owned failure value MUST express the facts required for its category and consumer decision using the applicable Type rules.

Category-specific data MUST belong to the appropriate variant. Unrelated optional fields MUST NOT make every combination appear valid. Status, category, and recovery information MUST NOT contradict one another or become independently mutable representations of the same fact.

### ERROR-008 — Machine identity is separate from display text

When consumers branch on a failure, the contract MUST provide a stable machine-readable discriminator or another documented classification mechanism.

Repository-owned consumers MUST NOT classify repository-defined failures by parsing human-readable messages. A vendor boundary that provides only text MAY interpret that text within its adapter when the limitation is documented and verified; the interpretation MUST remain isolated from domain consumers and MUST preserve unrecognized failures. Display text and localization MUST NOT silently change failure semantics.

### ERROR-009 — Category definitions and occurrences have separate lifetimes

Reusable category definitions MUST contain category-level facts. Request context, affected targets, causes, correlation data, and diagnostic stacks belong to the occurrence that produced them.

A mutable exception instance MUST NOT be reused as the failure of independent operations. Reuse of an immutable occurrence-free status or category value is allowed when the contract requires no per-occurrence evidence. An occurrence identifier is needed only when an actual correlation or consumer contract requires it.

### ERROR-010 — Context adds facts at the responsible boundary

Additional failure context MUST identify a useful fact such as the operation, phase, permitted target reference, or failed invariant that is unavailable or ambiguous in the incoming failure.

Context MUST be captured where its meaning is known. It MUST NOT invent a diagnosis, imply an unobserved effect, or duplicate the same message at every layer. Cause messages MUST NOT be concatenated into an ever-growing replacement for structured evidence. Useful wrapping remains subject to `FUNC-021`.

### ERROR-011 — Causal translation retains the original evidence

A translation MUST preserve the causal evidence required by its owning contract. In particular, `IFACE-015` requires internal cause preservation when useful; an expected-status translation does not automatically require retaining a diagnostic exception. Unexpected failures retain the observability required by `FUNC-010`.

Where causal evidence is required, the diagnostic path MUST retain the relationship and original evidence. A cause MUST NOT be replaced with only a rendered message when structured evidence is available and can be retained safely. A safe consumer projection MAY omit internal causes; the diagnostic owner MUST still retain or report the required evidence within its disclosure and retention contract. Retention does not require putting a runtime exception into public domain data.

For language-specific implementations, native JavaScript error causes and Rust error sources provide standard causal mechanisms. Their availability does not define the public failure projection. See [ECMAScript Error objects](https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-error-objects) and [Rust `Error::source`](https://doc.rust-lang.org/std/error/trait.Error.html#method.source).

### ERROR-012 — Caught values remain untrusted until established otherwise

A caught or received value MUST retain the trust level required by `TYPE-008`, `TYPE-020`, and `TYPE-021` until its representation has been established.

Handling code MUST account for the values its runtime or boundary can actually supply, including non-exception throws where supported. A name, cast, or unchecked property access MUST NOT establish a trusted domain failure. Inspecting arbitrary values MUST NOT allow a throwing property accessor, failed coercion, or malformed nested cause to erase the original failure path.

### ERROR-013 — Diagnostic ownership does not imply immutable data

A runtime exception, its cause, and its associated objects MUST be treated according to their actual ownership and mutation behavior. A read-only reference to an exception MUST NOT be presented as proof that its reachable contents form an immutable record.

When a failure enters a published record or shared application state, the applicable Object and Type ownership rules MUST be satisfied through a suitable projection or another allowed ownership design. Arbitrary runtime evidence MAY remain with a diagnostic owner. Universal freezing, cloning, and serialization of arbitrary exceptions are not required and MUST NOT substitute for deciding what a consumer may retain.

### Catching, propagation, and compound failures

### ERROR-014 — Every catch has a handling purpose

A catch or equivalent failure branch MUST perform a defined action: recover under a valid policy, translate the boundary contract, add necessary context, release owned resources, establish a terminal state, report at the responsible boundary, or propagate through a failure channel that requires explicit branching.

Explicitly returning or propagating an unchanged failure is valid when the language or selected result contract requires it. A redundant catch-and-rethrow wrapper that contributes none of those actions MUST be omitted. Catching a failure solely to suppress it or replace it with false success violates `FUNC-010`. A deliberate optional-feature fallback still requires the contract and evidence defined by this chapter.

### ERROR-015 — Catch scope matches the recognized failure

A handler for a specific recoverable condition MUST cover only the operations whose failures it can classify correctly, or otherwise retain enough provenance to distinguish those operations.

A broad block MUST NOT accidentally treat a validation defect, callback failure, cleanup rejection, or later mutation as the expected failure of an earlier read. Narrow lexical scope is the default when it makes that distinction explicit. Shared boundary handling is allowed when its classification preserves the originating phase and outcome.

### ERROR-016 — Unrecognized failures keep their unexpected status

A translator or recovery branch MUST establish which incoming failures it recognizes and how all others propagate to a failure owner.

An exhaustive match over known domain variants does not establish that every external exception belongs to those variants. A default branch MUST NOT reclassify arbitrary failures as not-found, invalid input, cancellation, or another expected condition. A terminal boundary MAY map an unexpected failure to its documented safe general response while preserving diagnostic observability.

### ERROR-017 — Propagation preserves identity unless translation is useful

When no required context or contract translation is added, a propagated failure SHOULD retain its original runtime identity and evidence where the language permits it.

Creating a replacement with the same message alone loses useful information without establishing a new boundary meaning. When identity cannot survive serialization or a language boundary, the adapter MUST preserve the contractually relevant category and safe context, with diagnostics handled separately. Consumers MUST NOT depend on memory identity across that boundary.

### ERROR-018 — Multiple failures retain their relationship

When more than one failure contributes to an outcome, its diagnostic representation MUST distinguish causes, independent sibling failures, and failures encountered while handling or cleaning up an earlier failure.

The representation MUST retain enough association to identify the affected operation or resource when that changes diagnosis or recovery. It MUST NOT label every member as the cause of every other member or invent a universal ordering of causal precedence. The chosen runtime aggregate or suppression mechanism MAY be used when it preserves the required relationships.

JavaScript `AggregateError` retains a collection of errors; the application still defines what the members mean. See [ECMAScript aggregate error objects](https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-aggregate-error-objects).

### ERROR-019 — Handler failure does not silently replace operation failure

If handling, translation, cleanup, or reporting can itself fail, the owner MUST define how the original failure and the secondary failure remain observable.

A throwing formatter, response writer, rollback, or diagnostic sink MUST NOT silently become the only surviving evidence. If the external boundary can expose only one outcome, it MUST select that outcome by its contract and preserve the remaining permitted evidence through the diagnostic path. This does not require exposing an internal aggregate to the caller.

### ERROR-020 — Reporting a failure does not complete its handling

A failure branch that reports a diagnostic MUST still propagate, recover, or establish the operation's documented terminal outcome.

Logging alone MUST NOT leave the operation pending, return an unrelated default, or imply success. Conversely, a correctly returned failure or rejected operation need not be logged again by every intermediary. Failure ownership and reporting ownership MUST be explicit at the point where propagation ends.

### Recovery and truthful outcomes

### ERROR-021 — Recovery requires a demonstrated valid state

A recovery path MUST establish the preconditions under which it can satisfy the operation's contract and restore every affected invariant required for continued use.

Recoverability MUST NOT be inferred solely from the presence of a catch, a familiar category, or the ability to construct a default value. If only part of the state has been recovered, the reported outcome and permitted next actions MUST reflect that limitation.

### ERROR-022 — Fallbacks honor the promised result

A fallback MUST satisfy an allowed outcome of the owning contract and identify any degradation that affects the consumer's decisions.

Optional preference storage may permit a usable default or a nonpersistent change if persistence was not promised. Missing-data defaults MUST NOT be extended to unreadable or corrupt data without an explicit recovery contract. Required writes, validation, authorization, and other promised effects MUST NOT be silently replaced by an apparently successful fallback.

### ERROR-023 — Failed security decisions do not grant authority

When a failure prevents a required security decision from being established, the affected action MUST remain ungranted unless a separate explicit policy can still establish the required authority.

A failed permission lookup, malformed credential, unavailable policy source, or diagnostic error MUST NOT select a permissive default. Any degraded operation must remain within authority that has actually been established. This is the failure-specific application of the API access rules. See [OWASP improper error handling](https://owasp.org/www-community/Improper_Error_Handling).

### ERROR-024 — Retry decisions include effects and ownership

A failure-triggered retry MUST use the affected operation's retry contract, including the existing API requirements where that boundary applies.

The decision MUST account for the failure condition, possible completed effects, cancellation, remaining budget, and the layer that owns repetition. A nested translator MUST NOT introduce a hidden retry policy that changes the caller's completion or duplicate-effect contract. Repeated handling MUST preserve the evidence needed to explain the final outcome without unbounded diagnostic accumulation.

### ERROR-025 — Cancellation is attributed to the affected work

Cancellation classification MUST be supported by the operation's actual cancellation contract and evidence that the observed outcome belongs to that cancellation.

A signal observed as cancelled after an unrelated failure does not alone prove that cancellation caused that failure. A matching human-readable message or unvalidated external exception name also does not establish it. Late completion, rejection of an accepted cancellation request, and work that cannot be cancelled MUST retain their actual outcomes.

### ERROR-026 — Loss of confirmation preserves uncertainty

A timeout, disconnect, abandoned wait, or lost response MUST NOT be treated as proof that the requested effect did not occur or was undone.

Where the effect matters to subsequent action, the failure path MUST expose the operation's defined uncertainty and reconciliation behavior under the existing API rules. An observed reconciliation result MUST state what it establishes; a current snapshot does not guarantee permanent absence, rollback, or the future state of concurrent work.

### ERROR-027 — Unrecoverable invariants have an explicit containment boundary

When a required invariant cannot be reestablished, the failure owner MUST stop further use of the affected invalid state and apply the documented containment or termination policy.

Ordinary rejected input and expected operational alternatives MUST NOT become process termination merely to avoid handling them. A panic, abort, or equivalent nonrecoverable mechanism requires a concrete invariant or runtime contract that makes continuation invalid. The policy MUST identify whether containment applies to the operation, resource owner, worker, or process; not every unexpected error requires the same scope.

Rust distinguishes recoverable failure from conditions that invalidate continued execution; the actual caller and invariant determine that decision. See [the Rust Book on choosing panic or recovery](https://doc.rust-lang.org/book/ch09-03-to-panic-or-not-to-panic.html).

### Async work, cleanup, and final state

### ERROR-028 — Accepted async work has a failure owner

The async observation requirements of `FUNC-017` MUST identify who receives or handles the failure of each accepted operation, including work whose initiating caller has returned.

Attaching a completion callback or using an all-settled combinator does not establish handling when failed results are discarded. Detached work requires an explicit owner and terminal policy. Process-wide rejection reporting is a final diagnostic boundary, not proof that the work's result, resources, or lifecycle were handled.

### ERROR-029 — Concurrent failure policy preserves member outcomes

An owner coordinating multiple operations MUST define which failure determines the caller's result, what happens to the remaining work, and where its later failures are observed.

Fail-fast notification MUST NOT imply that siblings stopped. An all-settled result MUST be interpreted according to the required member outcomes. Required failures MUST NOT disappear when one operation succeeds, and expected cancellation of remaining work MUST retain its relationship to the initiating failure rather than obscure it.

### ERROR-030 — Cleanup preserves operation and release failures

Failure handling that releases owned resources MUST apply the relevant resource rules, including all of `CLASS-027` when a class owns the lifecycle.

The diagnostic result MUST preserve an earlier operation failure together with every required cleanup failure under those rules. A finalizer, destructor adapter, or rollback failure MUST NOT silently overwrite the original occurrence. If the operation succeeded but required cleanup failed, the owner MUST report the outcome defined for that release failure rather than claim that the complete promised lifecycle succeeded.

### ERROR-031 — Failure state agrees with actual effects and usability

After failure, the operation's returned result, retained lifecycle state, persisted status, and visible state MUST agree on the facts each promises to represent.

An owner MUST NOT remain ready after failed cleanup when its contract requires a terminal state, or mark work durably complete when that fact was not established. Compensation and rollback MUST NOT be reported as successful merely because they were attempted. Where some effects remain, the outcome MUST preserve the partial or uncertain state relevant to the consumer.

### ERROR-032 — Superseded work cannot overwrite the current outcome

When work is replaced, cancelled, or detached from its consumer, a later failure MUST be attributed to the operation that produced it before it can change shared or visible state.

The relevant Hook and Component ownership rules apply to their constructs. Discarding an obsolete state update MAY be correct, but does not by itself satisfy the obsolete operation's resource and diagnostic responsibilities. Expected cancellation need not be promoted to a user-visible error merely to prove it was observed.

### ERROR-033 — Stream failures name the failed completion boundary

A failure in an ongoing interaction MUST identify whether it concerns establishment, an item, a sub-operation, or completion of the overall work, applying the existing API stream rules.

A closed channel MUST NOT be reported as successful completion without the contract's required evidence. After a transport can no longer accept its ordinary error response, the owner MUST use the supported terminal mechanism and diagnostic path. A failure of one independently scoped item MUST NOT silently rewrite the outcomes of earlier completed items.

### ERROR-034 — Recovery boundaries cover only the work they own

A framework, renderer, worker, or process failure boundary MUST identify which execution paths it actually intercepts and which resources or state it can recover.

A rendering boundary MUST NOT be assumed to handle unrelated event callbacks or asynchronous rejections. A global handler MUST NOT claim that a damaged owner is usable because a fallback screen or process listener ran. The relevant work must reach its actual failure owner, with Component recovery obligations retained under `COMP-161` where applicable.

### Consumer projections and reporting

### ERROR-035 — Consumer errors are deliberate projections

The failure information exposed to a consumer MUST be selected for that consumer's contract and trust boundary under the existing API and Object projection rules.

Internal exception messages, stacks, nested causes, provider responses, filesystem paths, or attached objects MUST NOT be forwarded merely because they are available. A generic safe response and a detailed internal diagnostic can represent the same occurrence without sharing their fields. Native exception serialization MUST NOT be treated as an authoritative public error schema.

### ERROR-036 — Public details enable an allowed next step

A user-facing failure projection MUST state the supported outcome and any valid next action with enough context to be useful, while honoring disclosure limits.

It MUST NOT promise a retry, recovery, persistence, or rollback that the operation cannot establish. Safe general wording is appropriate when a more specific explanation would disclose protected information or assert an unsupported diagnosis. Component presentation remains subject to its accessibility and complete-state rules.

### ERROR-037 — Reporting ownership limits duplicate diagnostics

A failure path MUST identify the boundary responsible for its terminal diagnostic reporting when such reporting is required for observability.

Intermediate layers SHOULD add structured context or propagate evidence instead of emitting the same terminal error repeatedly. Distinct trace events, recovery attempts, and independently failed operations MAY justify separate records when their roles remain clear. Expected outcomes need only the reporting required by their operational or consumer contract; not every rejection or cancellation requires an error-level log.

### ERROR-038 — Diagnostics remain bounded and disclosure-aware

Newly selected occurrence context and diagnostic projections MUST use bounds appropriate to their destination for variable-size messages and attached data. Traversing, rendering, or exporting cause graphs and aggregates MUST also have explicit bounds.

Permitted original evidence remains subject to its ownership and retention contract. Merely attaching a cause does not require mutating, cloning, traversing, or truncating it. Presentation bounds MUST NOT discard failures the lifecycle contract requires the owner to preserve.

Formatting MUST account for cycles and unsafe inspection where arbitrary runtime values can enter. It MUST NOT dump whole request bodies, credentials, user data, or provider objects as a convenience. Truncated diagnostics MUST NOT misleadingly imply that the displayed failures are complete; internal preservation and bounded external rendering are separate responsibilities.

### ERROR-039 — Correlation connects evidence without inventing identity

Where correlation is required, a failure response and its diagnostic records MUST use the operation's established correlation contract under `API-048` where applicable.

Category identifiers, occurrence identifiers, request identifiers, and trace identifiers MUST retain their distinct meanings. A newly generated identifier MUST NOT masquerade as the caller's original trace, and an externally supplied identifier MUST NOT be treated as proof of trust or authority. Correlation data exposed to a consumer must itself be permitted for that boundary.

### ERROR-040 — Reporting failure has a defined consequence

The owner of reporting MUST distinguish optional diagnostics from required audit or other reporting that is part of the operation's promised effects.

An optional diagnostic sink failure MUST NOT silently replace a valid operation outcome. Required reporting failure MUST follow its explicit completion and recovery contract. A reporting failure path MUST avoid recursive attempts through the same broken sink and retain an appropriate bounded fallback or terminal signal when one is required. Secondary failure preservation remains governed by `ERROR-019`.

### Documentation, compatibility, and verification

### ERROR-041 — Failure contracts document decisions and limits

The applicable callable, type, capability, and API documentation MUST describe the failure distinctions that affect consumers: the channel, recognized categories, required context, completion meaning, and supported recovery.

When relevant, it MUST also identify cancellation behavior, uncertainty about effects, partial results, diagnostic ownership, cleanup consequences, and limitations of external classification. Documentation MUST NOT list only exception names while leaving those decisions implicit. Repository-owned JavaScript and TypeScript declarations retain the JSDoc requirements.

### ERROR-042 — Failure evolution follows consumer compatibility

A change to a failure channel, discriminator, required field, interpretation, or recovery promise MUST be assessed under the existing compatibility rules for every supported consumer affected.

Adding a failure variant is not automatically compatible with exhaustive consumers. Converting a throw into a returned failure is not automatically compatible with callers awaiting rejection. Display text MAY evolve independently only where it is not a supported machine contract. Correcting an accidental leak still requires updating affected safe projections and documentation coherently.

### ERROR-043 — Tests distinguish recognized failures from unexpected ones

Verification of a changed classification or translation MUST cover its applicable recognized failures. Where the actual input boundary can supply unrecognized failures, it MUST also cover an unrecognized case that proves unexpected errors retain their required observability. A trusted closed input domain instead requires coverage of its valid variants; any separate untrusted entry point is verified at that boundary when affected.

Assertions MUST check the resulting category, required context, and caller-visible behavior. When the actual runtime boundary permits arbitrary thrown values, the relevant handling or formatting checks MUST include those shapes that could defeat its narrowing or failure preservation. Tests MUST NOT rely solely on full stack traces or incidental engine message text.

### ERROR-044 — Recovery tests prove effects and final state

A changed fallback, retry, reconciliation, or compensation path MUST be verified against its prerequisites and observable effects, including the case where recovery is not permitted or fails.

The checks MUST establish the relevant final state, permitted next action, and absence of false success. Where duplicate effects or partial completion are possible, verifying only the number of retry calls or the returned message is insufficient. Use controlled failure points and deterministic observations appropriate to the affected contract.

### ERROR-045 — Compound and asynchronous failures are verified together

When a changed owner coordinates concurrent work or failure-prone cleanup, verification MUST exercise the applicable combinations of operation failure, cleanup failure, later sibling failure, cancellation, and obsolete completion.

The checks MUST establish which outcome reaches the caller, that required work is settled or transferred to its documented owner, and that required failure evidence survives. A test that exercises only successful cleanup does not verify preservation of an earlier failure when cleanup also rejects.

### ERROR-046 — Boundary checks verify safe output and diagnostic evidence

A changed external failure boundary MUST be checked through its actual mapping and serialization path for the supported response shape, safe details, and preservation of permitted diagnostic evidence.

Relevant checks MUST establish that sensitive or arbitrary internal fields do not escape, including nested causes or provider attachments when those can reach the mapper. A changed reporting path MUST also verify its applicable sink-failure behavior. Documentation, examples, and tests MUST describe the same failure meaning; passing tests do not waive a violated construction rule.

## Boundary examples

These examples illustrate contract decisions. They do not certify every existing implementation using a similar pattern.

| Situation                                                                            | Required distinction                                                                                                                                            |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A decoder rejects a cursor while processing a named operation                        | Add the operation's useful context and preserve the decoding cause; expose only the allowed invalid-input detail to the caller.                                 |
| Service construction fails and two acquired resources also fail to close             | Preserve the construction failure and both cleanup failures with their roles; complete the owner's required release attempts and establish its terminal state.  |
| A stop command rejects but a subsequent observation finds no matching running model  | Report what reconciliation actually established according to the stop contract; retain the command diagnostic when required and do not claim permanent absence. |
| A settings file is missing, unreadable, or corrupt                                   | Apply the missing-file default only to proven absence. Other failures require their own recovery or propagation policy.                                         |
| Optional theme preference storage is unavailable                                     | A declared appearance fallback may remain valid. A caller promised durable persistence still needs a truthful persistence outcome.                              |
| A cancelled request's older callback rejects after a replacement request has started | Attribute the failure to the older request, preserve its ownership obligations, and prevent it from replacing the current request's state.                      |
| A stream is established, one sub-operation fails, and unrelated work completes       | Preserve each scoped outcome and the overall completion contract; neither initial connection success nor channel closure establishes all work succeeded.        |
| A native exception is attached to a read-only object                                 | Read-only access to the reference does not establish an immutable nested exception or safe public serialization. Select the actual required projection.         |
