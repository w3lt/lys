# Event and Message

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines how a message expresses a meaning, reaches the correct consumer, and produces an outcome consistent with its delivery and lifetime contract.

## Definition and scope

A **message** is an identified unit of information handed from a producer to a consumer through an explicit messaging, dispatch, or notification relationship. It can carry an event, a request, a proposed change, a response, or a state update. These meanings do not become interchangeable because they use the same transport.

An **event** reports an occurrence or observation at a defined point. A **command message** requests an action from its responsible owner. A **change proposal** requests a new value without establishing that the state owner accepted it. A **notification** tells an observer that something relevant happened or may have changed; its payload and contract determine what the observer can conclude.

A **snapshot** describes state at a defined observation point. A **delta** describes a change relative to a defined state or ordered sequence. An **invalidation** says that previously observed state may require refresh. A **reference** identifies data to obtain elsewhere. These are payload meanings, separate from whether delivery is local, synchronous, buffered, or remote.

The **producer** constructs or originates the message. A **dispatcher or intermediary** selects or transports it to receivers. A **consumer** interprets it. A **handler** performs the consumer's work. A **subscription** is the owned relationship through which a consumer becomes eligible to receive notifications. One message can have multiple delivery attempts and multiple consumers.

An **acknowledgement** confirms the exact stage defined by a protocol, such as receipt or completion of processing. A **checkpoint** records a consumer's progress through a sequence. **Replay** delivers previously recorded information again. None of these terms alone establishes durable business effects, complete history, or freedom from duplicates.

The rules apply to repository-defined message contracts, event payloads, publication and consumption paths, and the dispatch or subscription boundaries that connect them. A chat transcript record is not a delivery protocol merely because its domain name contains “message.” An ordinary function argument or return value does not acquire messaging machinery unless it actually participates in such a contract.

Native UI events, semantic component callbacks, and renderer notifications retain the exact ownership and phase restrictions of their existing standards. Synchronous local callbacks do not need network envelopes, acknowledgements, durable queues, global identifiers, or replay support merely because they notify another owner. This chapter does not prescribe an event bus, broker, event-sourced architecture, outbox, shared message base class, universal envelope, or subscription interface.

Asynchronous execution and stream coordination also follow [Async Task and Stream](./ASYNC.md); resource ownership and release follow [Resource](./RESOURCE.md). Configuration contracts also follow [Configuration](./CONFIGURATION.md). Schema contracts and migrations also follow [Schema and Migration](./SCHEMA.md). Tests and fixtures also follow [Test and Fixture](./TEST.md). Comment construction also follows [Comment](./COMMENT.md). Message and delivery documentation retains the requirements in this chapter.

## Existing rule ownership

Each active standard retains its exact triggers and permitted cases. Event rules connect those contracts across producers, delivery boundaries, and consumers.

| Concern                                                                                          | Authoritative rule or document                                                                                 |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Callable responsibility, naming vocabulary, immutable inputs, trust, outcomes, and side effects  | `FUNC-001` through `FUNC-003`, `FUNC-006` through `FUNC-011` in [Function](./FUNCTION.md)                      |
| Exhaustive handling, async and resource ownership, callbacks, useful wrappers, and tests         | `FUNC-015`, `FUNC-017` through `FUNC-021`, `FUNC-023` through `FUNC-026` in [Function](./FUNCTION.md)          |
| Valid variants, discriminants, trust, authority, mutability, names, compatibility, and encodings | `TYPE-002` through `TYPE-012`, `TYPE-017`, `TYPE-019`, `TYPE-020`, `TYPE-023`, `TYPE-024` in [Type](./TYPE.md) |
| Publication, immutable values, temporary ownership, and alias restrictions                       | `OBJECT-013` through `OBJECT-016` in [Object](./OBJECT.md)                                                     |
| Passive wire representations, validation, versions, and canonical bytes                          | `OBJECT-039` through `OBJECT-046` in [Object](./OBJECT.md)                                                     |
| Capability eligibility, exact completion, synchrony, cancellation, and resource ownership        | `IFACE-001` through `IFACE-007`, `IFACE-012` through `IFACE-020` in [Interface](./INTERFACE.md)                |
| Stateful owners, locking, cleanup, and immutable snapshots                                       | `CLASS-001`, `CLASS-016`, `CLASS-025`, `CLASS-027`, `CLASS-028`, `CLASS-035` in [Class](./CLASS.md)            |
| Semantic feature events, native primitive events, callback naming, and completion                | `COMP-029`, `COMP-036`, `COMP-037`, `COMP-091` through `COMP-100` in [Component](./COMPONENT.md)               |
| Subscription replacement, publication authority, phase restrictions, and store observation       | `HOOK-026` through `HOOK-033` in [Hook](./HOOK.md)                                                             |
| API authority, projections, partial effects, retry, deduplication, and uncertain outcomes        | `API-009`, `API-011` through `API-018`, `API-026` through `API-032` in [API](./API.md)                         |
| Wire framing, stream completion, buffering, reconnection, and compatibility                      | `API-033` through `API-041` in [API](./API.md)                                                                 |
| Failure classification, causes, handler failures, retries, ownership, and diagnostics            | [Error](./ERROR.md), especially `ERROR-003`, `ERROR-016`, `ERROR-019`, `ERROR-024` through `ERROR-040`         |
| Contract placement, dependency direction, publication, and consumer compatibility                | [Module and File](./MODULE.md) and [Package and Dependency](./PACKAGE.md)                                      |
| Documentation and change workflow                                                                | [JSDoc Standard](../JSDOC.md) and [Contributing to Lys](../../CONTRIBUTING.md)                                 |

The words publish, emit, send, dispatch, subscribe, and acknowledge describe concepts in this chapter; they do not add repository-designed function verbs to `FUNC-003`. Callback props retain `COMP-036`, named types retain the Type standard, and externally imposed names retain their existing exception. This chapter does not amend that naming vocabulary.

## Construction process

Before adding or changing an event or message:

1. Identify its producer, consumers, single meaning, and authoritative contract.
2. Distinguish an observed fact, requested action, proposed value, and reported outcome.
3. Define the payload's snapshot, delta, invalidation, or reference semantics where applicable.
4. Identify the necessary identities, ordering scope, and validity period.
5. Trace publication through dispatch or encoding to the actual consumer and handler.
6. Establish what acceptance, delivery, acknowledgement, and completion each prove.
7. Define the relevant failure, duplicate, retry, replay, overflow, and missing-recipient behavior.
8. Identify subscription ownership, re-entry, cleanup, and authority to apply late messages.
9. Assess trust, disclosure, retained history, and affected consumer versions.
10. Verify the applicable producer-to-consumer paths and their failure and lifecycle boundaries.

## Mandatory rules

### Meaning and contract authority

### EVENT-001 — Every message serves an identified consumer concern

A repository-defined message MUST communicate one coherent occurrence, request, proposal, or outcome to an identified consumer or supported consumer class.

Its purpose MUST be understandable without reconstructing the producer's private implementation. Topics, event variants, and subscriptions MUST NOT be added for hypothetical future consumers. An existing protocol's optional notifications may remain optional when their meaning and absence behavior are defined.

### EVENT-002 — Facts, requests, and proposals have distinct meanings

A message contract MUST distinguish what happened from what is requested or proposed whenever those states require different consumer behavior.

Observing an interaction does not prove its requested domain action completed. A proposed controlled value does not prove acceptance by the state owner. A message family MAY carry multiple meanings as explicit variants; a shared envelope or dispatch function MUST NOT erase those distinctions.

### EVENT-003 — Required actions have a responsible outcome owner

A command message or action callback MUST identify the owner responsible for accepting, rejecting, or completing the requested action and the outcome its initiator can observe.

Competing workers MAY implement one logical responsibility under an explicit allocation contract. Broadcasting a request MUST NOT make a required outcome depend on an accidental listener or silently turn one intended effect into multiple effects. Optional observers of a completed action are separate from the action's required owner under `COMP-037` where applicable.

### EVENT-004 — Messaging does not replace a missing architectural boundary

A messaging relationship MUST satisfy the existing Function, Interface, Class, Module, and Package rules for the constructs it introduces.

A global dispatcher MUST NOT be used to conceal direct dependencies, bypass an authoritative state owner, or turn unrelated operations into one arbitrary command channel. A current dispatch responsibility MAY justify shared infrastructure, but does not automatically justify an interface per message, a new package, or a stateful object literal. Passing a direct callback remains valid when it expresses the actual relationship.

### EVENT-005 — Names identify meaning at the correct scope

A message kind and its documented context MUST identify the occurrence, requested action, or proposed value and its affected domain concern.

Generic kinds such as a delta or completion indicator require an enclosing contract that makes their target and scope unambiguous. Repository naming standards remain authoritative for declarations and callbacks. Renaming a published kind to improve wording is still a compatibility change; this rule does not require breaking existing wire spellings or renaming externally imposed events.

### EVENT-006 — Producers and consumers share one contract authority

The message kind, payload, permitted metadata, and consumer interpretation MUST have an identified authoritative declaration or specification under the existing Type and Module rules.

Producer-local copies, consumer-local assertions, and documentation MUST NOT independently redefine the same fact. The authority may be a local type, shared protocol, generated contract, or external specification appropriate to the boundary. A common package or schema generator is required only when justified by actual ownership and consumers.

### Payloads, identity, and trust

### EVENT-007 — Variants define complete valid messages

Each repository-defined message variant MUST provide the data necessary for that variant's meaning and consumer decision under the Type rules.

Unrelated optional fields MUST NOT form an ambiguous message bag. A discriminator and payload MUST agree. A consumer MUST distinguish a supported variant it deliberately ignores from malformed input or an unsupported kind; any permitted forward-compatible handling belongs at the explicit boundary and MUST NOT construct a falsely trusted known variant.

### EVENT-008 — Payload shape exposes how state is interpreted

A message carrying state information MUST define whether it supplies a snapshot, a delta, an invalidation, or a reference whenever consumers could otherwise interpret it differently.

A delta MUST identify its application context through the message or authoritative enclosing relationship. An invalidation MUST NOT imply a complete replacement value. A reference-based consumer MUST account for data that has changed, disappeared, or become inaccessible before retrieval; reading current data is not automatically reconstruction of the historical occurrence.

### EVENT-009 — Publication preserves the payload's ownership contract

A repository-owned payload MUST satisfy the publication and immutable-value requirements of `OBJECT-013` through `OBJECT-016`, including publication by capture in a callback or queue.

One consumer MUST NOT modify a shared record so later consumers observe a different occurrence. Mutable builders remain private until publication. Native runtime event objects retain their actual external lifetime and mutation protocol; a read-only reference does not turn them into immutable domain records. Their permitted use at native boundaries does not authorize leaking them through feature contracts.

### EVENT-010 — Message identity has a defined scope

When deduplication, replay, correlation, or a consumer decision requires message identity, the contract MUST define what is identified, who assigns it, and where it is unique.

Repeated delivery of the same logical message MUST preserve the identity required by that contract. A new occurrence MUST NOT reuse an identity that would make consumers discard it as a duplicate. A payload hash, timestamp, resource identifier, or transport position MUST NOT be treated as occurrence identity without an explicit equivalence contract. Messages that need no such identity do not require a new identifier field.

CloudEvents provides one optional external convention: it scopes event identity by source and identifier and permits the same identity for a retransmitted event. It is not mandated by this chapter. See [CloudEvents 1.0.2 identity](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md#id).

### EVENT-011 — Related identifiers retain separate meanings

When present, occurrence identity, affected-resource identity, operation identity, correlation, causation, delivery-attempt identity, and subscription identity MUST remain distinguishable according to their contracts.

A single operation may produce several distinct messages; one message may be delivered more than once. Consumers MUST NOT use a conversation identifier as proof that a late update belongs to the current request, or treat a shared trace identifier as permission to deduplicate independent occurrences. Required relationships may be established by an owned channel rather than repeated in every payload.

### EVENT-012 — Time and sequence describe only established ordering

Timestamps and sequence values MUST define their source, unit, scope, and meaning when they influence consumer behavior.

Occurrence time, observation time, publication time, and receipt time MUST NOT be silently substituted. A wall-clock timestamp MUST NOT be treated as a causal or total ordering guarantee across producers without an actual supporting contract. A sequence number MUST identify its ordering domain and relevant restart or reuse behavior. Neither timestamps nor counters are mandatory for a message whose relationship already provides the required ordering.

### EVENT-013 — Delivery does not establish payload trust

Received or replayed messages MUST undergo the trust-boundary validation required by `FUNC-007`, `TYPE-008`, and `OBJECT-042` before entering trusted state.

Arrival on an expected topic, successful JSON decoding, a matching source-language type, or earlier storage does not establish every current invariant. Validation MUST apply to the selected kind, schema, relationships, and relevant bounds. Already validated local values do not require redundant decoding without a new trust boundary or invariant.

### EVENT-014 — Routing and payload interpretation agree

Where routing information and payload fields describe the same kind, target, version, or scope, the boundary MUST define their authority and handle contradictions explicitly.

A dispatcher MUST NOT authorize or select a handler using one target while that handler acts on an unrelated target from the payload. If a transport event name and an internal discriminator are intentionally independent, their mapping MUST be explicit. Protocol framing remains owned by `API-033`; a valid frame alone does not prove a valid message.

### Publication and delivery

### EVENT-015 — A published fact has reached its stated observation point

A producer MUST establish the condition reported by an event before making that event observable to consumers.

The contract MUST distinguish an attempted, accepted, tentative, persisted, or completed transition when those stages matter. Reporting an observed intent or provisional state is allowed when that is the event's actual meaning. A completed or durable event MUST NOT be emitted merely because the producer expects a later operation to succeed.

### EVENT-016 — State changes and required notifications have a consistency contract

When a state change and its notification are jointly required for correctness, the owner MUST account for failure between those effects under the existing atomicity and partial-outcome rules.

The contract MUST define recovery, reconciliation, or the reported partial outcome if the state changes but publication fails, or publication becomes visible before the required state is committed. A transaction in one store does not prove atomic delivery elsewhere. An outbox or equivalent mechanism is one possible implementation when justified; optional transient notifications do not automatically require durable messaging infrastructure.

### EVENT-017 — Completion states name the stage they confirm

A messaging operation's result MUST state the stage it confirms, applying `IFACE-014`, `IFACE-016`, `IFACE-017`, and the applicable API completion rules.

Construction, acceptance into a local buffer, transport write, receipt, handler invocation, completed processing, and durable effects are distinct stages. A sender resolving or a callback returning MUST NOT be interpreted as a later stage unless its contract establishes that guarantee. An acknowledgement's name or mere existence does not supply the missing evidence.

### EVENT-018 — Delivery guarantees identify their limits

A claimed delivery guarantee MUST identify its actual producer-to-consumer scope and the conditions under which messages may be lost, duplicated, delayed, or reordered.

Claims of at-most-once, at-least-once, or exactly-once behavior MUST say whether they concern attempts, receipt, processing, or effects, and which failures and retained state they cover. A broker's or transport's guarantee MUST NOT be extended to an external side effect without evidence. A best-effort local notification may be sufficient when its consumer contract permits loss.

### EVENT-019 — Missing and multiple recipients have defined outcomes

A publication or dispatch contract MUST define the relevant recipient model: one selected owner, competing consumers, identified recipients, or independent observers.

It MUST state what no eligible recipient means when the producer relies on delivery. Zero listeners may be valid for an optional notification, but MUST NOT silently complete a required command. A change in subscriber count MUST NOT accidentally change one logical action into repeated business effects.

### EVENT-020 — Fan-out defines how consumer failures affect delivery

A dispatcher with multiple consumers MUST define whether one consumer's rejection stops, delays, or leaves delivery to others unaffected, and how required outcomes are accounted for.

An exception or asynchronous rejection MUST NOT accidentally determine an undocumented fan-out policy. Partial delivery MUST remain distinguishable from complete processing when the caller needs that fact. This does not mandate isolation for every observer: deliberate fail-fast dispatch is allowed when its contract and remaining-work ownership are explicit.

### EVENT-021 — Handler work retains a completion and failure owner

Work started by a handler MUST retain the async and failure ownership required by `FUNC-017` and `ERROR-028` through `ERROR-029`.

An asynchronous callback is not observed merely because a dispatcher invoked it. If the dispatcher does not join callback completion, the handler or another named owner MUST own the remaining operation. Reporting at a global boundary does not settle its resources or state, and an ignored settled-result collection does not account for failed consumers.

### EVENT-022 — Dispatch timing is part of the consumer contract

A notification relationship MUST establish the timing that affects its producer or consumer: immediate invocation, deferred work, thread or executor placement, and the state visible when the handler runs.

Changing synchronous notification to deferred delivery, or invoking a callback earlier during registration, is a behavior change when consumers rely on timing. A type signature alone does not capture that change. Borrowed execution context, locks, transaction scope, and renderer phases MUST NOT be assumed to remain valid after deferred delivery.

### Ordering, repetition, and recovery

### EVENT-023 — Ordering guarantees have a named domain

Where message order matters, the contract MUST define the ordering domain and the required relationship between messages, such as one subscription, operation, resource, producer, or partition.

An ordered connection MUST NOT be presented as a global order across independent producers or concurrent work. Required predecessors and terminal boundaries MUST be explicit under `API-034` and `ERROR-033` where applicable. Concurrent title and assistant events can share a connection while retaining separate completion scopes.

### EVENT-024 — Consumer concurrency preserves the required order of effects

A consumer that processes ordered messages concurrently MUST establish how its state changes and external effects preserve the ordering its contract requires.

Receiving messages in order does not prove that asynchronous handlers finish in order. Serialization, partitioning, version checks, commutative updates, or another justified protocol MAY establish the needed behavior. The chosen mechanism MUST cover failures and later completion, not only the successful initial dispatch sequence.

### EVENT-025 — Duplicate handling protects the intended effect

When duplicate delivery is possible and affects correctness, the consumer MUST define how repeated messages produce the permitted effects under the applicable idempotence and deduplication rules.

The design MUST address the relevant identity scope, retention, concurrent duplicates, conflicting identity reuse, and failure between recording progress and applying effects. Merely remembering the last payload or checking before a non-atomic write does not establish duplicate safety. Equal text fragments may be distinct deltas and MUST NOT be discarded solely because their contents match.

### EVENT-026 — Acknowledgements and checkpoints match completed work

When acknowledgement or checkpoint progress controls redelivery, the consumer MUST define the relationship between that progress and its required effects.

Acknowledging before required work completes can lose recovery opportunities; acknowledging later can permit duplicates. The contract MUST account for its selected failure window and for concurrent or partial batch processing. A checkpoint MUST NOT skip unresolved required messages merely because a later handler completed, unless the protocol explicitly represents those gaps and preserves their outcomes.

Where progress authority can expire or move to another consumer, acknowledgements and checkpoints MUST be associated with the applicable delivery, consumer, or subscription generation. A late or repeated acknowledgement MUST NOT advance unrelated or replacement work.

### EVENT-027 — Retry remains owned and bounded

A message retry MUST follow the affected operation's recovery contract under `ERROR-024` and applicable API retry rules.

The responsible layer MUST identify which failures permit repetition, how remaining work and effects are reconciled, and what happens when the retry budget or validity period ends. Nested dispatchers MUST NOT multiply retries outside that contract. A redelivery attempt MUST preserve the logical identity needed by consumers while distinguishing attempt-level diagnostics when required.

### EVENT-028 — Unprocessable messages have a terminal disposition

A consumer that can repeatedly receive a message it cannot process MUST define a bounded disposition consistent with the delivery contract.

Rejecting, quarantining, recording failure, stopping the affected subscription, or deliberately discarding under an explicit policy MAY be appropriate. A poison message MUST NOT create an endless retry loop or disappear as false success. Retained failed messages require an owner, access and retention policy, and a defined recovery path if redrive is supported; a dead-letter queue is not mandatory for a local callback.

### EVENT-029 — Replay defines history, position, and gaps

A system advertising replay MUST identify the history it retains, its ordering and cursor scope, the included position, retention limits, and the outcome when requested history is unavailable.

Reconnection or resubscription MUST NOT silently imply replay. The consumer MUST know whether it receives historical messages, a current snapshot, only future notifications, or an explicit combination. At API boundaries, `API-037` remains authoritative for reconnecting and retrying. The absence of replay support is a valid contract when consumers can handle it.

SSE defines event identifiers and reconnection metadata, but a protocol participant must still supply any promised retained history. An SSE identifier may also carry forward across frames, so it is not inherently a unique identifier for every occurrence. See [the HTML event-stream specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header).

### EVENT-030 — Replay does not blindly repeat live side effects

A consumer supporting replay or redrive MUST define which effects may be repeated and which require suppression, reconciliation, or renewed authorization.

Rebuilding a projection from retained facts MUST NOT inadvertently resend user notifications, rerun a payment or write, or repeat another one-time effect simply because it uses the live handler. Historical observation and a new command are distinct operations. Replay tooling and consumer identity MUST preserve that distinction under the applicable safety and compatibility contracts.

### State application and subscription lifetime

### EVENT-031 — Snapshots and deltas share an explicit consistency point

A consumer combining a snapshot with deltas MUST establish which deltas are already included, which must follow, and how it handles missing or incompatible updates.

Applying a delta to the wrong resource, version, or operation MUST NOT silently produce apparently current state. A replaced snapshot MUST NOT cause already applied deltas to be appended twice or required deltas to be skipped. The contract MAY use a coherent local observation protocol rather than an explicit version field when it provides the required proof.

### EVENT-032 — Late messages retain their original authority

A message arriving after replacement, cancellation, navigation, or resubscription MUST be associated with the operation or relationship that produced it before it can change current state.

The Component, Hook, and Error stale-completion rules remain authoritative. An unchanged resource identifier does not prove that an older request still owns the view. Intentionally historical updates MAY be applied under a consumer contract that reconciles them; merely observing that the consumer still exists is insufficient.

### EVENT-033 — Buffering and coalescing preserve message meaning

A delivery path that can accumulate work MUST define and enforce the relevant limits and overflow policy for retained messages, bytes, and pending handlers under the applicable resource and API rules.

Coalescing, dropping, sampling, or replacing queued messages is allowed only when it preserves the consumer's required semantics or produces its documented loss or recovery outcome. A replaceable state snapshot is not equivalent to an append-only text delta, command, or required terminal message. Buffer bounds MUST cover the actual retained work rather than only the final output collection.

### EVENT-034 — Feedback paths cannot create unbounded redispatch

When handling a message can produce another message that reaches the same logical concern, the design MUST establish how the cycle terminates or remains within a deliberate bounded ongoing protocol.

Unchanged-state guards, authoritative ownership, correlation, or another justified mechanism MAY prevent unintended echoes. A generic forwarded flag or counter MUST NOT suppress legitimate independent occurrences without an identity contract. A bidirectional adapter MUST preserve which side owns the change rather than repeatedly treating its own echo as new intent.

### EVENT-035 — Re-entry preserves state and locking contracts

A handler or dispatcher that can be re-entered MUST define its policy for nested or overlapping invocation and for subscription changes during delivery.

The contract MUST establish whether new or removed listeners affect the current dispatch when that is observable. It MUST preserve `CLASS-025` locking and callback restrictions and `COMP-095` re-entry policy where those constructs apply. A synchronous callback MUST NOT observe an owner's half-applied transition, and a serialized owner MUST NOT wait on work queued behind itself.

### EVENT-036 — Each subscription has an exact lifetime owner

A subscription MUST identify who establishes it, which source and consumer instance it connects, and who ends it under the existing resource and lifecycle rules.

Registration identity MUST be sufficient to release that exact relationship without removing another consumer's subscription. A returned cleanup handle or supported scoped registration MAY provide that identity. Hiding a listener in a long-lived registry does not transfer ownership merely because the caller loses its reference.

Repeated registration MUST have a defined outcome and ownership, whether it is rejected, reuses or replaces a relationship, or creates an independent acquisition. Releasing one registration MUST preserve other registrations that remain valid under that contract.

### EVENT-037 — Initial observation and registration form one coherent contract

A consumer requiring current state plus future notifications MUST avoid an unaccounted gap between its initial observation and registration.

The contract MUST define whether registration can synchronously notify, how concurrent changes are reconciled, and what becomes visible if setup partially fails. An existing store or renderer protocol MAY supply that coordination; `HOOK-031` through `HOOK-033` retain their exact requirements. Consumers that require only future occurrences need not invent an initial snapshot.

### EVENT-038 — Teardown accounts for queued and active deliveries

Ending a subscription MUST establish whether further callbacks can start, what happens to already queued or running handlers, and who settles their remaining work.

The owner MUST release the intended registration and required resources under the applicable cleanup rules. Removing a listener does not by itself prove that every previously accepted callback or producer operation stopped. Unsubscription MUST NOT cancel shared application work solely because one observer departed; late delivery still follows the consumer's publication-authority contract.

### Native boundaries, disclosure, and evolution

### EVENT-039 — Native event protocols remain intact at their adapters

A native or framework event adapter MUST preserve the actual dispatch, phase, lifetime, cancellation, and propagation contract that its consumer is allowed to depend on.

Component event translation and native cancellation remain owned by `COMP-029`, `COMP-093`, and `COMP-096`; Hook notifications retain `HOOK-030`. Preventing a default, stopping propagation, requesting work cancellation, and rejecting a domain action MUST NOT be treated as equivalent. A native dispatch result MUST NOT be interpreted as asynchronous business completion.

For DOM events, cancellation and propagation are distinct mechanisms, and the dispatch result reports cancellation status rather than a domain operation's result. See [the DOM event standard](https://dom.spec.whatwg.org/#dom-eventtarget-dispatchevent).

### EVENT-040 — Deferred handlers retain only valid context

When handling outlives the initiating callback or delivery scope, the consumer MUST retain the required immutable domain values or another explicitly valid owned representation.

It MUST NOT later read a borrowed event field, mutable current target, ambient current selection, or pooled buffer as though it were a stable snapshot of the original occurrence. Native event fields may have phase-specific meaning even when their object remains reachable. Retaining a callback or message MUST also respect the lifetime of the resources and dependencies it captures.

### EVENT-041 — Message routing does not grant authority or disclosure

A messaging boundary MUST establish sender authority, permitted recipients, and allowed payload data under the existing trust, API, and Object projection rules wherever that boundary requires them.

A topic name, embedded actor identifier, correlation field, or claimed source MUST NOT by itself authorize the requested action. Broadcast delivery MUST NOT disclose data to a wider audience than its projection allows. Retained, delayed, or replayed work MUST define the relevant authorization point when permissions can change; earlier receipt is not automatic authority for a later effect.

### EVENT-042 — Delivery failures and reported failures stay distinguishable

A consumer MUST distinguish a message reporting a domain failure from failure to decode, deliver, process, or acknowledge that message whenever the distinction affects the operation's outcome.

Failure variants and internal diagnostics MUST follow the Error standard, including safe projections, preserved causes where required, and secondary failures. An error message about one sub-operation MUST NOT silently terminate unrelated work. Publishing a failure notification does not prove that it was received or that its initiating failure was handled.

### EVENT-043 — Diagnostics describe the actual delivery stage

Where message diagnostics are needed, reporting MUST identify the relevant stage, consumer, occurrence or operation, and attempt without changing their contract meanings.

An accepted-write metric MUST NOT be named as a completed-processing metric. Duplicate, rejected, dropped, expired, or replayed messages MUST remain distinguishable when operators need that distinction to establish outcomes. Context and payload logging remain bounded and disclosure-aware under `ERROR-037` through `ERROR-040`; full payload capture is not a default observability requirement.

### EVENT-044 — Message evolution includes retained and mixed-version consumers

A message-contract change MUST apply the existing Type, Object, API, Module, and Package compatibility rules to its supported producers, intermediaries, consumers, and retained messages.

An added kind or field is not automatically safe for a closed consumer. `OBJECT-045` owns exactly identifiable schema versions and permits selection through an envelope or authoritative protocol boundary; a separate version field on every local message is not required. Kind reuse MUST NOT reinterpret old retained messages, and routing or completion changes MUST be assessed even when the payload shape stays the same.

### Documentation and verification

### EVENT-045 — Documentation connects meaning to delivery behavior

The applicable message and callable documentation MUST identify the consumer-facing meaning, payload interpretation, actual delivery stages, and relevant ordering, failure, and lifetime contracts.

Where supported, it MUST also explain identity, duplicates, acknowledgement, retry, replay, overflow, validity, and compatibility. Documentation MUST distinguish guarantees from implementation observations and future plans. Merely listing payload fields or handler names is insufficient when correctness depends on these relationships. JSDoc requirements remain applicable to repository-owned declarations in scope.

### EVENT-046 — Representation checks exercise the actual message boundary

Verification of a changed message representation MUST exercise the real kind selection, encoding or dispatch mapping, validation, and consumer interpretation affected by the change.

Tests MUST cover applicable valid variants and rejected inputs, including routing/payload disagreement and malformed or unsupported data where the boundary admits them. A trusted closed local type does not require fabricated impossible values. Wire tests remain governed by `API-049` through `API-052`; matching producer and consumer types alone does not verify the serialized representation.

### EVENT-047 — Publication checks prove the claimed state transition

A changed publication path MUST be verified at the point where the event's stated fact becomes observable, including the relevant failure before or between required effects.

The checks MUST establish that tentative work is not reported as committed, acceptance is not mistaken for completion, and a failed required notification follows its consistency policy. For scoped completion, they MUST prove that an event terminates the intended work while permitted concurrent outcomes remain possible. Merely asserting that a sender was called is insufficient.

### EVENT-048 — Delivery checks include repetition and partial outcomes

When a changed path supports concurrent consumers, acknowledgement, retries, duplicate handling, or replay, verification MUST exercise the applicable ordering and failure windows for those guarantees.

Assertions MUST establish the resulting effects and progress, including relevant duplicate delivery, failure after an effect but before acknowledgement, unavailable replay history, consumer rejection, and partial batch completion. A path without those capabilities need not add them solely to create such tests. Real consumer contracts, not broker terminology alone, determine the cases.

### EVENT-049 — Lifetime and capacity checks control scheduling

A changed subscription or buffered delivery path MUST be verified with controlled registration, notification, replacement, teardown, and completion where those transitions affect correctness.

Applicable cases include notification during setup, partial setup failure, read/register races, nested dispatch, subscription mutation during dispatch, late callbacks, rejected async handlers, slow consumers, and overflow. The checks MUST establish the correct owner's state and resources and the meaning of retained or discarded messages. Timing sleeps alone are not proof of the required ordering.

### EVENT-050 — Compatibility evidence covers real supported combinations

A changed published or retained message contract MUST validate the affected producer/consumer and history combinations under the existing compatibility standards.

Fixtures, actual codecs, representative consumers, or retained-message samples MAY supply evidence appropriate to the supported contract. Tests and examples MUST NOT generate both the received and expected meaning from the same unchecked assumption. Documentation, rule references, and examples MUST agree with the verified contract; no test result waives an active construction rule.
