# API

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines the construction rules for supported programming boundaries and their consumer/provider contracts.

## Definition and scope

An **API** is a deliberately supported programming boundary through which an identified consumer obtains information, requests an operation, or observes a sequence of results from a provider. Its contract includes the available operations, accepted inputs, observable outcomes, access conditions, and compatibility obligations.

An **operation** is one named interaction through that boundary. An **endpoint** is an addressable transport entry for an operation, such as a method and route or a registered IPC command. An **adapter** translates an API's external representation and protocol into the contract used by its internal consumer or provider.

A **wire contract** is what crosses a serialized boundary, including operation identity, argument placement, encoded values, status or outcome indicators, metadata, and framing. A matching source-language type alone does not prove that either side sends or receives that contract.

A **supported consumer** is a current caller, integration, released client, or explicitly maintained consumer class. An API can be private to an application or repository while still crossing a process, language, trust, or independently updated deployment boundary.

A **completion boundary** identifies which named result has become true. Transport establishment, request acceptance, a persisted change, a generated reply, background work, and stream closure can have different completion boundaries.

The rules apply at the boundary they describe. Published in-process callables retain Function, Interface, Module, and Package ownership; they do not acquire HTTP status codes, network authentication, or serialization requirements merely by being APIs. Serialized network and IPC surfaces receive the rules for their actual transport and exposure. An ordinary internal helper does not become a separately published API merely because another function invokes it.

This chapter does not prescribe REST, RPC, HTTP, an API-description format, a shared package, one response envelope, a particular authentication mechanism, or a version field in every payload. Failure representations and handling also follow [Error](./ERROR.md); message meaning and delivery follow [Event and Message](./EVENT.md); asynchronous execution and stream coordination follow [Async Task and Stream](./ASYNC.md); resource ownership and release follow [Resource](./RESOURCE.md). Configuration contracts also follow [Configuration](./CONFIGURATION.md). Schema contracts and migrations also follow [Schema and Migration](./SCHEMA.md). Tests and fixtures also follow [Test and Fixture](./TEST.md). Comment construction also follows [Comment](./COMMENT.md). API interaction documentation retains the requirements in this chapter.

## Existing rule ownership

API rules connect the provider and consumer at a supported boundary. Existing construct rules retain their exact triggers and permitted cases.

| Concern                                                                                | Authoritative rule or document                                                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Operation cohesion, callable category, naming, and inputs                              | `FUNC-001` through `FUNC-006` in [Function](./FUNCTION.md)                                           |
| Trust-boundary validation, defaults, outcomes, side effects, and dependencies          | `FUNC-007` through `FUNC-012` in [Function](./FUNCTION.md)                                           |
| Async completion, resource ownership, useful adapters, and complete outcomes           | `FUNC-017`, `FUNC-018`, `FUNC-021`, `FUNC-025`, `FUNC-026` in [Function](./FUNCTION.md)              |
| Capability eligibility, ownership, and narrow consumers                                | `IFACE-001` through `IFACE-007` in [Interface](./INTERFACE.md)                                       |
| Capability preconditions, outcomes, completion, cancellation, and resources            | `IFACE-012` through `IFACE-020` in [Interface](./INTERFACE.md)                                       |
| External adapters, evolution, and shared conformance tests                             | `IFACE-030` through `IFACE-034` in [Interface](./INTERFACE.md)                                       |
| Valid value sets, absence, trust, and static/runtime schema authority                  | `TYPE-002` through `TYPE-009` in [Type](./TYPE.md)                                                   |
| Public types, proof, units, encoded formats, and mechanism isolation                   | `TYPE-017`, `TYPE-018`, `TYPE-020`, `TYPE-023`, `TYPE-024` in [Type](./TYPE.md)                      |
| Narrow patches, identifier normalization, serialization, versions, and canonical bytes | `OBJECT-023`, `OBJECT-024`, `OBJECT-029`, `OBJECT-039` through `OBJECT-046` in [Object](./OBJECT.md) |
| Supported entry points, contract placement, environments, generation, and moves        | [Module and File](./MODULE.md)                                                                       |
| Dependency contracts, delivery, artifact compatibility, and consumer verification      | [Package and Dependency](./PACKAGE.md)                                                               |
| Component and hook consumers of API operations                                         | [Component](./COMPONENT.md) and [Hook](./HOOK.md)                                                    |
| Documentation and compatibility approval                                               | [JSDoc Standard](../JSDOC.md) and [Contributing to Lys](../../CONTRIBUTING.md)                       |

A collection of endpoints is not automatically one behavioral Interface construct. Endpoint schemas are data contracts; substitutable internal capabilities use the Interface standard when its eligibility conditions hold. The Interface operation-count limit applies to each actual Interface, not to the total routes exposed by an application.

Limit declarations, units, and recursive data constraints remain governed by `CONST-009`, `CONST-010` in [Constant](./CONSTANT.md) and `TYPE-022` in [Type](./TYPE.md). Deterministic observable collection ordering remains governed by `OBJECT-034` in [Object](./OBJECT.md).

## Construction process

Before adding or changing an API operation:

1. Identify its consumer, provider, supported entry, and single purpose.
2. Trace the actual call through serialization, transport, registration, validation, authorization, domain work, and response consumption where applicable.
3. Identify the authoritative declarations and the constructs governed by existing standards.
4. Define required inputs, wire representations, access conditions, and observable outcomes.
5. State exactly what success, acceptance, cancellation, and a lost response mean.
6. Identify ownership of resources, concurrent work, retries, and streamed results.
7. Assess actual exposure, privileged targets, data disclosure, and bounded resource use.
8. Identify every supported producer/consumer combination affected by the change.
9. Keep registration, adapters, documentation, and the actual serialized contract consistent.
10. Verify the relevant boundary using a real provider path and representative consumers.

## Mandatory rules

### Boundary and authority

### API-001 — A supported boundary has identified consumers and owners

An API MUST identify who provides its contract, who currently consumes it, and which entry points are supported.

Publication through routing, IPC registration, generated clients, or package exports MUST agree with that boundary. Physical reachability, a callable helper, or a schema file alone does not establish a supported operation. Module and Package rules continue to govern source visibility and distribution.

### API-002 — Each operation exposes one coherent outcome

An operation MUST give its consumer one coherent purpose and outcome under `FUNC-001` and `FUNC-026`.

Its boundary MUST make clear whether it observes information, requests a change, or establishes an ongoing observation. One endpoint MUST NOT become an unrelated command dispatcher through arbitrary mode flags or unbounded operation names. A supported batch operation can remain cohesive when its membership, outcomes, and atomicity form one explicit contract.

### API-003 — Interaction dimensions are explicit

An operation's contract MUST distinguish the dimensions that affect its caller: synchronous or deferred completion, single or streamed results, mutation or observation, and local or serialized invocation.

These are independent dimensions. A successful transport response can establish a stream or acknowledge deferred work without proving the requested business outcome. A query can be asynchronous without becoming a command.

### API-004 — Operation identity is authoritative and stable

A serialized operation MUST have one authoritative identity, including the required combination of method, address, command name, namespace, or protocol version.

Provider registration and consumer construction MUST derive from that authority or be checked against it. Correcting spelling or reorganizing routes is a compatibility change when consumers already use the old identity. Wire identifiers follow the chosen protocol; repository-designed callable names still follow `FUNC-003`.

### API-005 — Contract declarations describe the same boundary

Schemas, source-language types, route descriptors, generated definitions, and API documentation MUST identify which declaration owns each fact, applying `TYPE-009`, `IFACE-029`, and `MODULE-041` where relevant.

A request schema does not establish response framing, registration, authentication, or completion semantics that it does not encode. Any maintained representation of those facts MUST agree with its owner. A separate description file or generated client is justified by a current consumer or toolchain requirement, not by the existence of an API alone.

### API-006 — Adapters preserve policy ownership

An API adapter MUST apply the existing Function and Interface boundaries when translating a request, response, or failure.

Routing and framework details MUST NOT become inputs to domain policy merely because they are convenient in the handler. A thin handler still owns its complete boundary work; delegating domain logic does not justify skipping access checks, response mapping, or terminal failure handling. Splitting the handler across files does not change its responsibility.

### Inputs and representations

### API-007 — Argument location and decoding are part of the contract

A serialized operation MUST define where each input is supplied and how it is decoded, including relevant path, query, headers, body, envelope, and IPC argument names.

Repeated parameters, conflicting sources, duplicate representations, and unsupported encodings MUST have an unambiguous boundary policy. The consumer and provider MUST NOT assign different meanings to the same bytes through implicit coercion or precedence. Framework parsing behavior that affects accepted input belongs in this assessment.

### API-008 — Presence semantics survive the boundary

An API MUST preserve the absence, null, empty, default, and explicit-value distinctions required by `TYPE-007`, `FUNC-008`, and `OBJECT-041`.

Partial updates MUST distinguish leaving a value unchanged, assigning a value, and clearing it where those are different operations. Omitted values MUST NOT acquire an undocumented default from a serializer, decoder, or receiving language. Unknown-field handling remains owned by `OBJECT-042`, including its explicit forward-compatibility allowance.

### API-009 — Validation covers every untrusted direction

The trust-boundary requirements of `FUNC-007` and `OBJECT-042` MUST be applied to incoming requests and to externally supplied responses, events, or IPC results before their values enter trusted application state.

The boundary MUST identify which validations the actual decoder performs and which invariants remain to be checked. Shared types, generic client return types, generated declarations, or a successful status do not prove the received value. Already validated internal values do not require redundant parsing without a new invariant.

### API-010 — The transmitted representation matches the declared value

For each serialized input and outcome, the API MUST establish that the sender's actual encoding is accepted with the intended meaning by the receiver under `OBJECT-039` through `OBJECT-044`.

Review the relevant number ranges, units, timestamps, identifier formats, optional fields, tagged variants, collection forms, and language-specific conversions. A source value that cannot survive the chosen transport MUST use an explicit boundary representation. Memory identity and source-language method behavior are not transmitted data contracts.

### API-011 — Read and write projections expose only permitted fields

Request and response representations MUST use the field-selection rules of `OBJECT-023` and `OBJECT-040` for their actual consumers and permissions.

A writable API projection MUST NOT accidentally grant changes to provider-owned identifiers, ownership fields, derived state, or internal lifecycle controls. A readable projection MUST NOT expose fields solely because they exist in a database row, runtime object, or vendor response. Reusing one shape for both directions requires the same field semantics and access contract.

### API-012 — Payload acceptance has enforceable bounds

A boundary accepting variable-size input MUST define and enforce the relevant limits on bytes, collection sizes, string lengths, nesting, and decoded expansion before that input can drive disproportionate work or allocation.

Limits MUST describe the actual accepted representation, including compressed or encoded content when supported. The rejection outcome belongs in the API contract. Merely documenting a maximum or bounding one field while leaving an equivalent alternate representation unbounded does not enforce it.

### API-013 — Target interpretation agrees with access and execution

When an input identifies a resource, the canonicalization required by `OBJECT-029` MUST yield the same target for access checks and the eventual operation.

Path decoding, case handling, Unicode normalization, aliases, or redirects MUST NOT let validation authorize one target while execution selects another. An identifier's valid shape establishes representation validity; existence and permission to act on the target remain separate checks.

### Access and exposure

### API-014 — Caller authority comes from the trusted boundary

An exposed API MUST identify its allowed caller class and the mechanism or explicit trust assumption establishing caller authority.

Where callers have different privileges, trusted identity and scope MUST come from the authenticated or capability-controlled boundary. Request fields claiming a user, tenant, role, or permission MUST NOT grant that authority. A deliberately unauthenticated operation MUST be designated as such and limited to the access its contract permits.

### API-015 — Authorization covers the operation and selected data

Where access is restricted, authorization MUST cover the requested operation, each selected resource, and the fields or transitions the caller can read or change.

Checking that a caller can reach a route is insufficient to authorize an arbitrary supplied resource identifier. Batch membership and nested resources require the same assessment. Enforcement MUST occur in the trusted provider path and remain valid when the operation commits. See OWASP's [object-level authorization guidance](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/).

### API-016 — Transport reachability is not an access decision

Network or IPC exposure MUST be bounded to the actual supported callers, hosts, origins, and capabilities. Transport protection MUST match the confidentiality and integrity required by that exposure.

Loopback binding limits reachability; it does not identify the calling application. Browser cross-origin policy governs browser interaction and is not general API authorization. Browser-callable operations MUST account for their actual cross-origin and ambient-credential risks. A privileged native command MUST respect the host's capability boundary. These distinctions follow the [Fetch CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol) and OWASP's [REST security guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).

### API-017 — Disclosure policy includes failures and metadata

An API's permitted disclosure MUST cover successful data, error details, headers, redirects, diagnostic identifiers, and observable resource-existence information where sensitive.

Credentials and sensitive user data MUST NOT be copied into URLs, diagnostics, or error messages merely to simplify debugging. Internal details MAY be available to a separately authorized diagnostic owner under the repository's sensitive-data rules. Public responses MUST preserve the caller-safe contract across both expected and unexpected failures.

### API-018 — Caller-selected destinations remain constrained

An API that accepts a file path, URL, executable target, provider address, or equivalent authority-bearing destination MUST constrain its use to the operation's permitted resources and mechanisms.

The validation MUST account for the actual resolution path, including redirects or links when followed. Typed or syntactically valid destinations MUST NOT grant access to arbitrary local resources, internal services, or executable behavior. This rule is triggered by destination-taking operations; it does not require unrelated routing controls on APIs without such inputs.

### API-019 — Work admission accounts for amplified cost

An API whose requests can create significant work MUST define enforceable limits for the relevant concurrency, queued work, fan-out, duration, output, and retained resources.

Batching, retries, streaming, and downstream calls MUST remain within those limits. The contract MUST define what consumers observe when admission is refused or capacity is exhausted. Limits can belong to an existing service or host rather than every handler, provided the boundary enforces them. See OWASP's [resource-consumption guidance](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/).

### Responses and observations

### API-020 — Success identifies the fact established

An API success outcome MUST expose the postcondition actually established by the owner under `FUNC-026` and, for capabilities, `IFACE-014` and `IFACE-016`.

The result MUST distinguish observation from a guarantee about future state, and acceptance from completed work. A reconciliation snapshot proving that no model instance is currently loaded does not promise that another runtime client cannot subsequently load one. A transport success MUST NOT conceal a domain failure defined by the operation's result contract.

### API-021 — Failure representations support stable client decisions

A serialized API MUST map its declared failure outcomes to stable machine-readable distinctions and caller-safe information. Consumer decisions MUST NOT depend on incidental exception wording or localized display text.

When HTTP Problem Details is the chosen representation, its problem identifier, HTTP status, media type, and occurrence fields MUST follow that format; the `type` identifier is the primary problem classification. See [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html). A problem payload is not a license to expose implementation internals or invent a new error taxonomy outside the operation's contract.

### API-022 — Protocol indicators and payloads agree

Every operation MUST obey its chosen protocol's semantics for methods, status or outcome indicators, content metadata, and body presence.

For HTTP, safe methods MUST NOT request a domain mutation; `202` acknowledges acceptance without completion; `204` has no response content. Response media types MUST describe the actual representation. See [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html). Method-specific obligations also apply, including the patch contract in [RFC 5789](https://www.rfc-editor.org/rfc/rfc5789.html) when using HTTP PATCH. These constraints do not require a JSON envelope for bodyless responses, streams, or native commands.

### API-023 — Empty results and unavailable information stay distinct

An observation API MUST preserve the result distinctions established by the owning Function and Type contracts across transport mapping.

An empty collection, missing resource, unavailable provider, forbidden result, stale observation, and failed read MUST NOT be collapsed into the same success value when callers need to respond differently. If the access policy deliberately conceals existence, the outward absence/failure mapping MUST be consistent with that policy.

### API-024 — Collection traversal defines ordering and completeness

An API returning a potentially large collection MUST expose a bounded traversal contract appropriate to its consumer, including supported ordering, limits, filters, and continuation where applicable.

The contract MUST state whether traversal observes one snapshot or changing live data and what duplication or omission can occur during concurrent changes. Continuation values MUST remain bound to the relevant query and access scope. A full-list operation is permitted when the accepted collection is demonstrably bounded; pagination is not mandatory for every list.

### API-025 — Cached observations retain their scope and freshness

When responses can be reused from a cache, the API MUST define the relevant freshness, invalidation, representation selection, and caller/access scope.

A cache key or shared response MUST NOT conflate consumers whose permitted data differs. HTTP cache controls MUST implement the intended policy under [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html); disabling storage and requiring revalidation are different instructions. Cache metadata does not itself provide authentication or confidentiality. An operation requiring a current authoritative observation MUST NOT silently substitute a stale cached result.

### Mutation and deferred completion

### API-026 — Mutation boundaries expose atomicity and partial effects

An API mutation involving multiple changes MUST define its externally observable commit boundary and what remains if a later step fails.

The contract MUST distinguish an atomic operation, a supported partial result, and compensating recovery where applicable, while satisfying the selected protocol's obligations. A transaction inside one store does not imply atomicity across a filesystem, remote runtime, or background task. The API MUST NOT claim rollback or all-or-nothing completion that its actual owners cannot provide.

### API-027 — Concurrent requests have a conflict contract

When concurrent requests can invalidate an operation's assumptions or overwrite a newer result, the API MUST define its conflict and ordering policy at the authoritative mutation boundary.

The chosen mechanism MAY use conditional writes, version checks, serialization, or another justified owner protocol. A read followed by an unchecked write MUST NOT masquerade as an atomic precondition. Consumers MUST be able to distinguish the relevant conflict outcome from successful completion and determine whether a fresh read or explicit retry is required.

### API-028 — Retry permission follows operation semantics

An API and its client adapter MUST define whether retry is permitted for the applicable failures and uncertain outcomes. Automatic retries MUST NOT be inferred from a timeout, connection failure, or method name without the corresponding operation guarantee.

Idempotence concerns repeated intended effects; it does not require identical response bodies or status codes on every attempt. HTTP defines its method guarantees in [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html). A non-idempotent request needs an explicit deduplication, reconciliation, or consumer decision before repetition can be treated as safe.

### API-029 — Deduplication guarantees have a complete scope

When an API offers idempotency keys or equivalent deduplication, its contract MUST define the key's scope, request equivalence, retention period, concurrent duplicate handling, conflicting reuse, and the result that can be replayed.

The deduplication record and protected effect MUST have a consistency strategy that supports the promised guarantee across relevant failures. `OBJECT-046` governs byte-level request identity when used. A correlation identifier alone MUST NOT be described as deduplication, and expiration MUST NOT silently imply permanent exactly-once execution.

### API-030 — Lost acknowledgements leave an explicit uncertainty

When the provider may have committed work before the consumer receives an outcome, the API MUST identify how the consumer treats that uncertainty.

The supported choices can include querying an authoritative operation or resource, retrying under a valid deduplication contract, or reporting that completion is unconfirmed. A disconnect or deadline MUST NOT be mapped to proof that no mutation occurred. The contract need not invent a recovery endpoint when the supported caller can handle an explicitly uncertain result.

### API-031 — Deadlines and cancellation describe both sides

For cancellable or time-bounded operations, the API MUST expose the client and provider effects of deadline expiry or cancellation under `FUNC-017`, `FUNC-018`, and applicable Interface lifecycle rules.

The contract MUST distinguish stopping observation, requesting work cancellation, acknowledging cancellation, and reversing completed effects. It MUST account for work that can outlive the requesting connection. Cancellation propagation MUST preserve the actual owner's authority; borrowed application work is not cancelled merely because one observer stops waiting.

### API-032 — Deferred acceptance exposes an observation contract

An API that accepts work for later completion MUST identify the lifecycle owner, the acceptance guarantee, and how the consumer can observe the outcomes it needs.

Where status is exposed, the operation identity, state transitions, failure visibility, and retention MUST be defined. The owner MUST observe terminal failure under `FUNC-017`, even if the caller requires no completion channel. Returning an acknowledgement before starting unowned work MUST NOT be presented as a completed operation or a durable queue guarantee.

### Streaming interactions

### API-033 — Framing and payload validation are separate contracts

A serialized streaming API MUST define its transport framing, encoding, media type, and payload variants. The receiving transport adapter MUST reconstruct complete protocol units across arbitrary transport chunk boundaries and apply the relevant trust validation before publishing their values to its consumer. A typed in-process stream of already validated values does not repeat that decoding; its consumer still follows the stream's operation and lifetime contract.

Malformed, oversized, truncated, and unsupported units MUST have defined outcomes. A network chunk is not necessarily one event. For SSE, framing follows the [HTML event-stream specification](https://html.spec.whatwg.org/multipage/server-sent-events.html); merely sending JSON with an event-stream media type does not establish correct framing.

### API-034 — Completion events identify their exact scope

A streaming contract MUST specify what each completion or failure indicator terminates: an item, subtask, requested operation, or the whole exchange.

It MUST define allowed ordering, required predecessors, permitted later messages, and the meaning of closure without a required outcome. A generic `done` or `error` name is insufficient when parallel tasks have different lifetimes. A consumer MUST NOT end unrelated work or report full success solely because one subtask has completed.

### API-035 — Disconnect behavior follows work ownership

A streamed operation MUST state what continues, settles, or is cancelled when the consumer disconnects, stops iteration, or rejects a received unit.

The producer and client adapter MUST preserve the resource-owner contracts of `FUNC-017` and `FUNC-018`, including partial output and late completion. Closing a reader releases an observation resource; any effect on upstream work depends on the documented cancellation path. Persisted side effects remain subject to `API-026` and `API-030`.

### API-036 — Slow consumers cannot create unbounded retained work

A streaming API MUST define the supported policy when production outpaces consumption, applying its resource limits to buffered bytes, pending messages, and upstream work.

Flow control, bounded buffering, explicit coalescing, or termination MAY satisfy the contract where their semantics are appropriate. Meaningful messages MUST NOT be silently dropped or reordered. A transport's buffering behavior alone is not evidence that the application has bounded its retained work.

### API-037 — Reconnection does not imply replay or resumption

When reconnecting is supported, the API MUST distinguish starting a new operation, retrying the original request, and resuming an existing observation.

A resumable contract MUST define event identity, cursor scope, retention, ordering, duplicate handling, and gaps. SSE event identifiers and reconnect behavior do not create durable replay storage; see the [HTML event-stream specification](https://html.spec.whatwg.org/multipage/server-sent-events.html). An API without replay support MUST NOT advertise a resumable stream. Automatically repeating a mutation after disconnect requires the explicit retry guarantee under `API-028` and, when used, the deduplication contract under `API-029`; absence of event replay does not itself prohibit a safe request retry.

### Compatibility and evolution

### API-038 — Compatibility includes observable behavior

API compatibility assessment MUST include affected producers and consumers, wire identity, accepted values, outcomes, permissions, timing, ordering, side effects, and lifecycle guarantees.

Matching type signatures do not prove compatibility. The existing Type, Interface, Module, Package, and Contributing requirements still apply, including atomic internal interface updates or sibling published capabilities under `IFACE-031`. A new version label does not waive those requirements or authorize a breaking change.

### API-039 — Additive changes are checked against actual readers

An API change adding a field, variant, outcome, or operation MUST be evaluated against the actual acceptance and branching behavior of supported consumers and providers.

A strict decoder, closed union, exhaustive switch, signature check, or exact request matcher can reject an apparently additive change. Compatibility MUST NOT rely on ignoring unknown data unless the explicit boundary policy permits it under `OBJECT-042`. Loosening validation everywhere is not a migration strategy.

### API-040 — Version selection is explicit where versions can differ

Where serialized data can cross deployments or software versions, the API MUST identify its schema version through the mechanism required by `OBJECT-045`.

That identity MAY be carried by an authoritative protocol boundary rather than every body. Independently evolving peers MUST have a defined supported-version policy and explicit handling of unsupported combinations. A negotiated handshake is required only when the supported interaction needs negotiation; a coordinated release contract must still identify and verify the compatible pair it delivers.

### API-041 — Retained data has its own compatibility lifetime

An API whose data can survive the current connection or release MUST account for the consumers of persisted records, queued work, cached results, replay data, and saved continuation values.

Changing an endpoint version MUST NOT silently reinterpret those representations. Their schema selection and migration remain governed by `OBJECT-045`, and their availability and expiration must remain consistent with the API's documented recovery and continuation guarantees.

### API-042 — Capability claims reflect available behavior

If an API publishes capabilities, feature availability, or supported operations, those claims MUST describe behavior the selected provider is ready and permitted to perform for the relevant consumer.

Unavailable operations MUST produce their declared unsupported or unavailable outcome; they MUST NOT silently succeed through no-ops. Capability changes during a session need an explicit observation or failure contract when consumers can encounter them. A capability flag does not permit an optional unsupported method inside an Interface forbidden by `IFACE-008`.

### Integration and publication

### API-043 — Client adapters preserve protocol outcomes

A client adapter MUST distinguish transport failure, protocol mismatch, declared provider failure, and a valid operation result to the extent required by its consumer contract.

It MUST inspect the actual status or outcome, representation metadata, and body availability before decoding the expected result. A generic deserialization failure MUST NOT silently replace a meaningful declared failure, and successful decoding alone MUST NOT override a failed transport outcome. Unknown or malformed responses remain boundary failures rather than trusted domain data.

### API-044 — External provider details stop at the chosen adapter

Integration with an external API MUST respect the adapter and dependency rules of `IFACE-030`, `TYPE-024`, and the Package standard.

Repository-facing outcomes MUST preserve the semantic differences the consumer needs without requiring it to inspect vendor exception classes, raw transport objects, or incidental response strings. Translation MUST NOT invent stronger completion, cancellation, or retry guarantees than the provider supports. Direct dependency use remains permitted where the active standards do not require an adapter.

### API-045 — Native commands are verified across both languages

A cross-language or native IPC API MUST define its command registration, argument envelope, serialized names and variants, response encoding, and rejection representation.

Its consumer-facing contract MUST be checked against the receiving implementation, including nullability and the actual nested argument shape. A typed invocation does not prove command existence or serialization compatibility. Privileged operations retain the host's access and lifecycle restrictions rather than inheriting trust from a frontend type annotation.

### API-046 — Publication connects the complete supported path

Before an operation is described as available, its contract, implementation, registration, required dependencies, and supported consumer path MUST agree.

A route constant, unused handler, unregistered native function, or generated client method MUST NOT be documented as a working operation solely because its declaration exists. Removal MUST account for its consumers and compatibility obligations rather than only deleting the implementation. Repository-owned public surfaces remain governed by Module and Package publication rules.

### API-047 — Examples describe the current complete contract

API documentation and examples MUST use supported entry points, valid required inputs, accurate outcomes, and the actual lifetime guarantees, following `MODULE-047` and the repository documentation workflow.

Examples MUST distinguish illustrative omissions from executable requests. An executable request MUST NOT omit a required field or imply an unavailable operation. Known implementation limits MUST be stated without redefining the authoritative contract or presenting future behavior as already available.

### API-048 — Diagnostics correlate work without exposing its data

Where an API interaction spans requests, tasks, or services and needs correlated diagnostics, the boundary MUST define which identifiers can be propagated and which owner records the relevant outcomes.

Untrusted correlation values MUST be bounded and handled as data. Diagnostic metadata MUST NOT become authorization, deduplication, or a substitute for an operation result. Recording enough evidence to distinguish admission, processing, completion, and failure MUST remain consistent with the disclosure policy in `API-017`.

### Verification

### API-049 — Verification exercises the actual provider boundary

The tests required by `FUNC-024` and applicable capability standards MUST exercise the API layer that owns the claim: routing or registration, argument decoding, validation, access enforcement, response serialization, and consumer decoding where relevant.

Tests of the domain function alone cannot establish a serialized contract. A generated type match cannot establish real bytes or IPC envelopes. Focused provider injection and representative consumer tests MAY be used when they faithfully exercise the relevant boundary; a live network is necessary only for behavior the narrower setup cannot observe.

### API-050 — Rejection checks observe both outcome and side effects

API validation MUST include the applicable malformed, missing, extra, unsupported, forbidden, and over-limit inputs and verify their declared boundary outcomes.

Where rejection must precede a mutation or privileged operation, the test MUST establish that the protected work did not occur. Status-specific success and failure representations, bodyless outcomes, and caller-safe diagnostics require checks at their actual serialization boundary. Passing happy-path tests does not verify access restrictions or failure mapping.

### API-051 — Temporal checks include uncertain and interrupted outcomes

For APIs with relevant asynchronous, concurrent, retry, or streaming behavior, verification MUST control completion and exercise the applicable ownership transitions.

Cases include a lost acknowledgement after commit, duplicate or conflicting requests, cancellation, late completion, partial failure, slow consumers, malformed frames, premature closure, and resumption gaps when supported. Assertions MUST cover the actual consumer-visible result and owned effects; observing a cancellation request alone does not prove that work stopped or was rolled back.

### API-052 — Compatibility evidence uses supported consumer combinations

An API change MUST validate the affected producer/consumer combinations under the existing Type, Interface, Module, and Package compatibility requirements.

This MAY use contract fixtures, real encoders and decoders, cross-language boundary checks, or maintained older consumers appropriate to the supported release policy. Tests MUST NOT derive both the sent and expected representation from the same mistaken assumption while bypassing the boundary being changed. Validation reports MUST identify what was exercised and any host, network, security, or released-client behavior the chosen environment could not verify.

## Review criteria and SOLID application

| Principle | Observable review question                                                                                     | Governing rules                                |
| --------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| SRP       | Does an operation expose one coherent outcome while adapters retain only their boundary responsibility?        | `API-002`, `API-006`, `FUNC-001`, `FUNC-026`   |
| OCP       | Does a current extension vary through a real capability rather than an arbitrary endpoint dispatcher?          | `API-002`, `API-042`, `IFACE-003`, `IFACE-025` |
| LSP       | Do providers and versions preserve the consumer's complete observable contract?                                | `API-020`, `API-038`, `API-044`, `IFACE-022`   |
| ISP       | Does each API projection or actual Interface expose only the consumer's required information and capabilities? | `API-011`, `IFACE-006`, `IFACE-007`            |
| DIP       | Do transport and provider mechanisms stop at the appropriate boundary without contaminating domain contracts?  | `API-006`, `API-044`, `TYPE-024`, `IFACE-030`  |

These questions do not justify an interface per endpoint, a generated client without a consumer, speculative versioning machinery, or a separate package solely because an operation is called an API.

## Review checklist

- [ ] Supported consumers, providers, entry points, and authoritative declarations agree.
- [ ] The operation's purpose and completion boundaries are explicit.
- [ ] Actual argument placement, encoded values, presence, and decoding match on both sides.
- [ ] Validation, target resolution, permissions, and field projections preserve the correct authority.
- [ ] Exposure, disclosure, payload size, and amplified work have appropriate controls.
- [ ] Status, media type, payload, absence, and failure meanings form one coherent contract.
- [ ] Mutations define atomicity, concurrency, retry safety, and uncertain outcomes where applicable.
- [ ] Deferred and streamed results define ownership, ordering, limits, and termination.
- [ ] Version selection and migration preserve every supported consumer and retained-data lifetime.
- [ ] Registration, native bridges, external adapters, and documentation match the published behavior.
- [ ] Tests exercise the actual boundary and its relevant rejection, lifecycle, and compatibility cases.
