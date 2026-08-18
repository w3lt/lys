# Interface

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

## Definition

An interface is a named behavioral contract for an open set of substitutable implementations. It tells a consumer which operations it may invoke and the observable guarantees of those operations without exposing implementation details.

An interface describes behavior only. It MUST NOT describe stored data, attributes, state layout, configuration, component props, request or response payloads, DTOs, or serialized records. An explicit property accessor is a behavioral operation only when it satisfies the [Class](./CLASS.md) accessor rules; a data property remains prohibited.

The construct boundary is mandatory:

| Concern                                               | Required construct                                             |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| Data, attributes, properties, state, or payload shape | Type, record, struct, enum, or equivalent value construct      |
| Substitutable object behavior                         | Interface, trait, protocol, or equivalent behavioral construct |
| Data and object behavior mixed in one interface       | Prohibited; split into a type and one or more interfaces       |
| Stateful behavior implementation                      | Class, struct, module, or equivalent implementation construct  |

A callback or function value MAY use the language's function-type construct and MAY be carried by a data type as a parameter, option, prop, dependency, or result. This exception does not permit a type alias whose primary purpose is to expose a reusable object capability.

```ts
// Prohibited: an interface describes data.
interface ChatViewProps {
  readonly atBottom: boolean
  readonly onScrollPositionChange: (atBottom: boolean) => void
}

// Required: the record is data, and the callback is a carried value.
type ChatViewProps = {
  readonly atBottom: boolean
  readonly onScrollPositionChange: (atBottom: boolean) => void
}
```

```ts
// Prohibited: a type alias describes an object capability.
type ConversationWriter = {
  saveConversation(conversation: Conversation): Promise<void>
}

// Required: the interface describes behavior.
interface ConversationWriter {
  saveConversation(conversation: Conversation): Promise<void>
}
```

The compiler accepting another representation does not make it compliant.

## Construction recipe

Before creating an interface:

1. Name the single consumer-visible capability.
2. Identify the current production consumer requiring it.
3. Identify at least one current provider.
4. Verify that a real boundary, substitution need, or declared extension point justifies the interface.
5. Confirm that the implementation set is open rather than a closed finite domain.
6. Place the contract with its high-level consumer or stable public API owner.
7. List only operations that the identified consumer uses.
8. Split operations with different purposes, permissions, lifecycles, owners, or implementation sets.
9. Keep the complete effective operation count between one and five.
10. Define every method under the Function standard and every accessor under the Class standard.
11. Define every structured input, result, and failure with compliant data types.
12. Specify preconditions, postconditions, absence, failure, side effects, completion, and ownership.
13. Specify ordering, concurrency, cancellation, and lifecycle when applicable.
14. Remove framework, storage, vendor, and transport details from the contract.
15. Verify that every provider can support every operation without no-ops or unsupported-operation failures.
16. Add API documentation to the interface and every operation.
17. Create one shared contract test suite for every production implementation and reusable fake.
18. Verify that consumers never inspect, downcast, construct, or select concrete implementations.

## Interface categories

Every interface MUST have one primary justification category.

### Boundary capability

Allows high-level policy to use an external mechanism or nondeterministic dependency without depending on its implementation API.

```ts
interface ConversationReader {
  findConversationById(
    conversationId: ConversationId,
    cancellation: AbortSignal
  ): Promise<FindConversationResult>
}
```

### Selectable strategy or extension capability

Defines behavior supplied by multiple currently selectable implementations or by an explicit plugin boundary.

```ts
interface ConversationFormatter {
  formatConversation(conversation: Conversation): FormattedConversation
}
```

### Lifecycle capability

Allows a consumer that owns a resource lifecycle to perform its valid transitions.

```ts
interface RuntimeLifecycle {
  startRuntime(): Promise<void>
  stopRuntime(): Promise<void>
}
```

Callbacks and standalone function values remain Function constructs. They are not object-capability interfaces under this chapter.

## Example scope

Rule-specific examples isolate the rule under discussion. A `Required` or `Compliant` label means compliant with that rule; declarations and documentation unrelated to the demonstrated rule may be omitted. Complete examples at the end demonstrate the combined construction rules.

## Mandatory rules

### IFACE-001 — Data uses types; capabilities use interfaces

`TYPE-011` is authoritative for selecting between value and behavioral constructs. Applied to interface construction:

- Records, DTOs, props, state, configuration, options, inputs, results, snapshots, and metadata MUST use a type, record, struct, or equivalent value construct.
- A substitutable repository-owned object capability MUST use an interface, trait, protocol, or equivalent behavioral construct.
- A data-only interface is prohibited.
- A type alias whose primary purpose is to expose reusable object operations is prohibited.
- An interface mixing data members and operations is prohibited.

```ts
// Prohibited
interface RuntimeState {
  readonly status: RuntimeStatus
}

type ConversationReader = {
  findConversationById(
    conversationId: ConversationId
  ): Promise<Conversation | undefined>
}

// Required
type RuntimeState = {
  readonly status: RuntimeStatus
}

interface ConversationReader {
  findConversationById(
    conversationId: ConversationId
  ): Promise<Conversation | undefined>
}
```

A data type MAY contain callback or function-valued properties and MAY contain interface-typed dependencies. The exception applies only when the enclosing type's primary purpose is to carry data, parameters, options, props, dependencies, or results. An object that consumers depend on to perform domain or external operations is a behavioral capability regardless of member syntax.

### IFACE-002 — Interfaces contain operations only

A repository-owned interface MUST contain one or more required instance-operation signatures. An operation is either an instance method or an explicit getter or setter declaration.

It MUST contain zero:

- Data properties, including `readonly` properties.
- Function-valued properties such as `save: (...) => ...`.
- Index signatures or indexers.
- Constants, configuration, or default values.
- Static members or constructor signatures.
- Implementation state or default method bodies.
- Optional operations.
- Call signatures used to model callbacks or standalone functions.

```ts
// Prohibited: function property syntax remains property syntax.
interface ConversationWriter {
  saveConversation: (conversation: Conversation) => Promise<void>
}

// Required
interface ConversationWriter {
  saveConversation(conversation: Conversation): Promise<void>
}
```

An explicit accessor is allowed only when every provider implementation satisfies `CLASS-017`, `CLASS-018`, and `CLASS-019`. In addition, a current consumer MUST require the same synchronous local property contract from every provider. JavaScript and TypeScript interfaces MUST use `get` or `set` syntax; changing a data property into accessor syntax without this interface-specific evidence does not make it behavioral.

```ts
// Prohibited: this is a data property.
interface DraftEditor {
  readonly content: DraftContent
}

// Required: these are explicit behavioral accessor operations.
interface DraftEditor {
  get content(): DraftContent
  set content(content: DraftContent)
}
```

Each getter and setter is one operation. Setter declarations remain governed by `CLASS-019`.

An interface whose methods merely mirror stored attributes is a disguised data record and is prohibited:

```ts
// Prohibited
interface Conversation {
  getConversationId(): ConversationId
  getConversationTitle(): ConversationTitle
}

// Required
type Conversation = {
  readonly id: ConversationId
  readonly title: ConversationTitle
}
```

A zero-argument query method is behavioral only when it observes, retrieves, or calculates a value at invocation time and its timing, failure, or effect contract matters. A bounded synchronous local property read uses an accessor instead.

### IFACE-003 — Every interface requires current evidence

An interface MAY be introduced only when the completed change contains a real production consumer, a known provider, and at least one of these conditions:

1. It separates high-level policy from storage, network, filesystem, time, randomness, process state, operating-system access, or another external mechanism.
2. Two or more production implementations are currently required.
3. A plugin or extension boundary is an explicit current requirement.
4. A language or framework contract requires an interface at an adapter boundary.

A test double alone does not justify an interface. Anticipated future implementations, naming symmetry, and mocking pure code are not evidence.

When valid alternatives form a closed finite domain, use a closed type and exhaustive handling instead of an interface.

### IFACE-004 — The consumer owns the interface

The domain, application module, or stable public API requiring the capability MUST own the interface. Provider modules import and implement that contract.

Domain and application consumers MUST depend only on the interface. The composition root is the only production wiring module that may select and construct a concrete provider. Provider implementation modules and provider contract tests MAY reference both the owned interface and the provider solely to implement or verify conformance.

When several consumers require an identical contract, place it with their closest stable high-level owner. A provider MUST NOT publish a broad mechanism interface merely for consumers to narrow themselves.

The interface MUST use consumer vocabulary and domain types. It MUST NOT expose database rows, HTTP clients, filesystem handles, vendor SDK values, framework request objects, provider configuration, or mechanism-specific errors unless that mechanism is intentionally the consumer's domain.

This is the interface-level application of DIP.

### IFACE-005 — One interface represents one capability

An interface MUST be describable by one sentence of the form: “A `<capability name>` can `<single behavioral responsibility>`.”

All its operations MUST share:

- The same domain authority.
- The same core invariants.
- The same lifecycle and resource owner.
- The same category of reason to change.
- One abstraction level.

An interface MUST be split when its operations differ in domain purpose, consumer group, permission, lifecycle, transaction boundary, independently selectable implementation, abstraction level, or availability across providers.

Names requiring `And`, `Or`, `Manager`, `Utility`, or similarly broad wording indicate multiple capabilities and are prohibited.

This is the interface-level application of SRP.

### IFACE-006 — An interface exposes one to five operations

A repository-owned interface MUST expose at least one and no more than five effective operations. Five is a maximum, not a target.

The count includes declared methods, explicit getters, explicit setters, inherited operations, and every overload signature imposed by an external parent contract. A getter-and-setter pair counts as two operations.

An interface MUST be split when:

1. It exceeds five effective operations.
2. Consumers require different operation subsets.
3. Operations change for unrelated requirements.
4. Operations require different permissions.
5. Operations have different lifecycle, transaction, or resource owners.
6. Any valid provider cannot support every operation.
7. Query and command groups are consumed independently.

A zero-operation marker interface is prohibited. Use a branded type, annotation, closed type, or language-provided marker construct for non-behavioral classification.

An externally imposed interface exceeding the limit MUST be isolated under `IFACE-030`.

### IFACE-007 — Consumers receive only what they use

Every production consumer MUST invoke every operation of the interface it receives or deliberately forward that capability to a collaborator that invokes it.

Tests do not count as production usage. If consumers use different subsets, they MUST receive separate interfaces.

```ts
// Prohibited: this consumer can also write and delete.
function loadConversation(
  repository: ConversationRepository
): Promise<Conversation> {
  // ...
}

// Required
function loadConversation(
  conversationReader: ConversationReader
): Promise<Conversation> {
  // ...
}
```

One provider MAY implement several narrow interfaces. The composition root may pass the same provider to different consumers under different interface types.

This is the interface-level application of ISP.

### IFACE-008 — Optional and unsupported operations are prohibited

Every provider MUST support every operation in the interface.

An interface MUST NOT declare optional operations. A provider MUST NOT represent unsupported behavior by:

- Throwing `NotImplemented` or `Unsupported`.
- Returning a sentinel value.
- Performing a no-op.
- Requiring capability probing.
- Inspecting provider identity.
- Supplying default fallback behavior that conceals a missing capability.

Optional capabilities require separate interfaces and explicit consumer dependencies.

### IFACE-009 — Names identify capabilities

An interface name MUST identify a singular domain capability or consumer role without naming its implementation.

Compliant examples include:

- `ConversationReader`
- `ConversationWriter`
- `ConversationFormatter`
- `Clock`
- `RuntimeLifecycle`

Interface names MUST NOT:

- Begin with `I` or `T`.
- End with `Interface`, `Contract`, `Port`, `Base`, or `Abstract`.
- Include a concrete mechanism.
- Use vague standalone roles such as `Manager`, `Helper`, `Utility`, `Processor`, `Service`, or `Provider`.

Implementation names MUST identify the mechanism followed by the capability. For example, providers of `ConversationReader` may be named `SqliteConversationReader` and `InMemoryConversationReader`.

Names such as `ConversationReaderImpl`, `DefaultReader`, `BaseReader`, and numeric implementation suffixes are prohibited.

### IFACE-010 — Interface operations follow their construct standards

Every interface method MUST satisfy every applicable `FUNC-*` rule, including:

- One operation.
- Canonical operation vocabulary.
- A domain-specific name.
- No mode-selection flags.
- No more than three positional parameters.
- One explicit outcome contract.
- Explicit side effects.
- One abstraction level.
- Mandatory API documentation.

Repository-owned interface methods MUST NOT use overloads. Use distinct operations or one explicit input type instead.

Every explicit interface accessor MUST satisfy `CLASS-017`, `CLASS-018`, and `CLASS-019`. Accessors also satisfy every applicable Function rule; `FUNC-003` defines their naming and parameter-shape exception.

Generic dispatch methods are prohibited:

```ts
// Prohibited
interface ConversationGateway {
  execute(operation: string, payload: any): Promise<any>
}

// Required
interface ConversationReader {
  findConversationById(
    conversationId: ConversationId
  ): Promise<Conversation | undefined>
}
```

Signatures imposed by an external contract remain isolated under `IFACE-030`.

### IFACE-011 — Signatures use explicit domain data types

Every operation MUST explicitly define its parameter, result, absence, and expected failure contracts.

A structured input, result, state, or error crossing an interface MUST use a separately named compliant data type. An interface MUST NOT hide such contracts in inline object shapes.

```ts
// Prohibited
interface ConversationWriter {
  saveConversation(input: {
    conversationId: string
    title: string
  }): Promise<{ version: number }>
}

// Required
type SaveConversationInput = {
  readonly conversationId: ConversationId
  readonly title: ConversationTitle
}

type SaveConversationResult = {
  readonly version: ConversationVersion
}

interface ConversationWriter {
  saveConversation(
    input: SaveConversationInput
  ): Promise<SaveConversationResult>
}
```

`any` is prohibited. `unknown` is allowed only at an intentional trust boundary that validates it before domain use.

Mechanism-specific types such as database rows, vendor errors, HTTP objects, and filesystem handles MUST NOT cross a domain-facing interface. All signature types remain governed by `TYPE-*`.

### IFACE-012 — Documentation is the authoritative contract

Every interface and every operation MUST have JSDoc, rustdoc, or the language-equivalent API documentation.

Interface documentation MUST identify:

- The capability and intended consumer.
- Its domain responsibility.
- Lifecycle and ownership rules.
- Concurrency model.
- Substitutability expectations.

Each operation MUST document applicable:

- Preconditions.
- Successful result and postconditions.
- Absence semantics.
- Expected failures.
- Side effects.
- Completion point.
- Idempotency.
- Cancellation.
- Resource ownership.

Implementations MAY document mechanism-specific details and stronger postconditions. They MUST NOT strengthen preconditions, weaken guarantees, change contract meanings, or otherwise contradict the interface contract.

### IFACE-013 — Preconditions are exact

Every precondition MUST be encoded in parameter types when possible.

A remaining precondition MUST be documented precisely and checked before avoidable side effects begin.

An implementation MUST NOT:

- Reject input accepted by the interface.
- Add provider-specific restrictions.
- Require undocumented setup calls.
- Depend on hidden environment or process state.
- Require a stronger precondition than another implementation.

If an operation requires a validated or constrained value, its parameter type MUST guarantee that invariant before the operation is called.

### IFACE-014 — Postconditions are exact

Every operation MUST define what successful completion guarantees, including applicable:

- Returned value.
- State transition.
- Persistence or durability point.
- Visibility of the effect.
- Atomicity.
- Ownership transfer.
- Ordering guarantee.

Every implementation MUST provide at least the declared guarantee.

A method named `saveConversation` MUST NOT resolve successfully after merely scheduling or buffering the save when the contract promises persistence.

### IFACE-015 — Absence and failure are provider-independent

Equivalent outcomes MUST use exactly one representation across all implementations.

One implementation MUST NOT return `undefined` for absence while another throws or returns `null`.

For expected failures, implementations MUST:

- Produce only documented failure categories.
- Translate expected mechanism failures into domain-facing failures.
- Avoid leaking database, vendor, framework, filesystem, or transport errors.
- Preserve the underlying cause internally when useful.
- Never convert failure into success, absence, or a no-op.

Unexpected errors MUST remain observable under `FUNC-010`. They MUST NOT be converted into success, absence, or a falsely expected failure.

Unsupported behavior is not an expected failure; it violates `IFACE-008`.

### IFACE-016 — Side effects and completion are exact

Every operation MUST retain one primary category defined by the Function standard.

A calculation or query MUST NOT create externally observable state changes. A boundary adapter MUST limit its behavior to validation or translation at its declared boundary.

A command or side-effecting orchestrator MUST document:

- The state or external effect it changes.
- Whether it is atomic.
- Whether identical repeated calls are idempotent.
- What remains changed after failure.
- The exact point at which success is reported.

An implementation MUST NOT add undocumented effects, mutate inputs without explicit ownership transfer, or launch untracked background work.

If an operation only accepts or queues work, its name and contract MUST say so. It MUST NOT claim the final domain effect is complete. A new operation verb MUST first be defined by `FUNC-003`.

### IFACE-017 — Synchrony is part of the contract

Every implementation MUST preserve whether an operation is synchronous or asynchronous.

A synchronous operation MUST perform bounded work without waiting for external I/O, another process, user interaction, or an unbounded lock.

An operation that may perform such waiting MUST use the language or runtime's asynchronous contract.

An asynchronous operation MUST NOT report a successful outcome until its documented success postcondition is true. Expected failure, absence, or cancellation outcomes MAY complete according to their explicit contracts. One implementation MUST NOT report success after queueing while another reports success after completion.

### IFACE-018 — Potentially unbounded work is cancellable

An operation that may wait on a network, process, lock, stream, queue, user interaction, or input without a validated upper bound MUST accept the application stack's explicit cancellation value.

Cancellation MUST be either:

- The final positional parameter.
- A named field of the operation input type.

Every implementation MUST:

- Observe cancellation.
- Stop starting new owned work.
- Release acquired resources.
- Return the canonical cancellation outcome.
- Never report success unless the success postcondition completed.

Any irreversible commit point reached before cancellation MUST be documented.

### IFACE-019 — Implementations are ready when exposed

An implementation MUST be fully usable when returned or injected.

Required asynchronous initialization MUST occur inside a factory that returns the ready interface:

```ts
// Prohibited: the consumer knows provider initialization.
const reader = new SqliteConversationReader(configuration)
await reader.initializeDatabase()

// Required: the returned capability is ready.
const reader = await createSqliteConversationReader(configuration)
```

Lifecycle operations may appear in an interface only when the consumer genuinely owns that lifecycle. Lifecycle and operational capabilities MUST be separate when different consumers own them.

For an explicit lifecycle:

- `start` or `open` succeeds only when the capability is ready.
- `stop` or `close` MUST be idempotent.
- Valid transitions MUST be documented.
- Non-lifecycle operations after closure MUST produce one documented closed-state failure. Repeated `stop` or `close` calls MUST preserve their documented idempotent outcome.
- No provider may require additional undocumented setup or ordering.

### IFACE-020 — Resource ownership is complete

An operation returning a stream, subscription, session, lock, iterator, transaction, or other managed resource MUST define:

- Who owns the resource.
- Whether ownership transfers.
- How and when it is released.
- Whether release is synchronous or asynchronous.
- What cancellation and failure release automatically.
- What happens when release is repeated.

Partially acquired resources MUST be released after failure or cancellation.

A resource MUST NOT depend on garbage collection or process termination as its normal cleanup mechanism.

### IFACE-021 — Mutable representation must not escape

An interface MUST NOT expose mutable internal state through a reference, collection, iterator, buffer, handle, or mechanism object.

A returned value MUST be one of:

- Immutable.
- An independent copy.
- A resource with explicit ownership.
- A narrow behavioral capability controlling allowed mutation.

When `Message` is a deeply immutable type under `TYPE-010`, the following signature prevents callers from mutating either collection membership or message values:

```ts
interface ConversationReader {
  listConversationMessages(
    conversationId: ConversationId
  ): Promise<readonly Message[]>
}
```

Returning `Message[]` is also allowed when the collection and every mutable element are independent copies whose ownership transfers to the caller. The contract MUST state that transfer explicitly.

An implementation MUST NOT retain a mutable input after a call unless shared ownership or ownership transfer is explicitly part of the contract.

### IFACE-022 — Every implementation is fully substitutable

Every implementation MUST preserve the complete interface contract.

An implementation MUST NOT:

- Strengthen preconditions.
- Weaken postconditions.
- Add expected failure categories.
- Add observable side effects.
- Change absence representation.
- Return before the promised completion point.
- Change input or result meaning.
- Change mutation or ownership rules.
- Weaken cancellation, concurrency, ordering, or cleanup guarantees.
- Require additional call ordering.
- Leave any operation unsupported.

If an implementation cannot satisfy every item, it does not implement that interface.

This is the interface-level application of LSP.

### IFACE-023 — Consumers cannot identify implementations

Consumer logic MUST NOT use:

- `instanceof`.
- Concrete-type checks.
- Downcasts.
- Reflection on implementation type.
- Provider-name comparisons.
- Mechanism-specific imports.
- Capability flags.
- Branches based on provider identity.

```ts
// Prohibited
if (reader instanceof SqliteConversationReader) {
  await reader.prepareDatabase()
}

// Required
const result = await reader.findConversationById(conversationId, cancellation)
```

Provider selection is allowed only at the composition boundary before injection.

If a consumer needs additional behavior, define a separate capability interface. Do not discover it through runtime probing.

### IFACE-024 — Dependencies are supplied explicitly

A consumer MUST receive an interface dependency through:

- A constructor parameter.
- A function parameter.
- A typed dependency object.

A high-level consumer MUST NOT:

- Construct the concrete provider.
- Import a mechanism-specific singleton.
- Read the dependency from global state.
- Use a service locator.
- Select implementations through environment checks inside domain logic.

```ts
type LoadConversationDependencies = {
  readonly conversationReader: ConversationReader
  readonly clock: Clock
}
```

A data dependency object MAY contain interface-typed properties. This is an approved composition pattern, not a mixed interface.

The composition root owns provider selection, construction, initialization, and lifecycle wiring.

This is the interface-level application of DIP.

### IFACE-025 — A declared extension axis remains open

For a valid extension interface, adding another implementation MUST require changes only to:

- The new provider.
- Composition-root registration or configuration.
- Registration of the provider factory in the existing contract suite.
- Provider-specific tests.

It MUST NOT require:

- Editing consumer policy.
- Adding provider branches.
- Changing existing implementations.
- Changing contract-suite assertions.
- Exposing provider identity through the interface.

This applies only when `IFACE-003` establishes a real extension requirement. A closed finite domain uses a closed type and exhaustive handling instead.

This is the interface-level application of OCP.

### IFACE-026 — Interface composition preserves narrow capabilities

An interface MAY extend or compose only other behavioral interfaces.

Composition is allowed only when:

1. The child is substitutable for every parent.
2. A current production consumer requires every effective operation.
3. All operations form one capability.
4. No contracts conflict.
5. The complete interface remains within the five-operation limit.
6. Lifecycle and ownership rules remain identical.

Composition MUST NOT introduce:

- Data members.
- A concrete class.
- Mechanism-specific declarations.
- Diamond inheritance requiring precedence rules.
- Unrelated capabilities grouped for provider convenience.

An implementation MAY implement several independent interfaces without creating a composite interface.

### IFACE-027 — Generic relationships must be necessary and provable

Interface generics and associated types MUST satisfy `TYPE-013`, `TYPE-014`, and `TYPE-015`.

Each generic or associated type MUST:

- Appear in at least one operation signature.
- Express a relationship required by the consumer.
- Use the narrowest valid constraint.
- Have the same semantic meaning for every implementation.
- Be inferable or provable from an input, schema, or implementation declaration.

They MUST NOT expose an implementation-selected database, vendor, framework, or transport type to a high-level consumer.

A Rust associated type is allowed only when it expresses a relationship used by an operation. A Go type-set constraint is governed by the Type chapter rather than treated as a runtime capability.

### IFACE-028 — Conformance is explicit

Every named production implementation MUST declare its conformance using the language's strongest available mechanism.

Examples include:

- TypeScript class: `implements ConversationReader`.
- TypeScript object value: an explicit annotation or `satisfies ConversationReader`.
- Rust: `impl ConversationReader for SqliteConversationReader`.
- Java or C#: explicit interface implementation.
- Go: a compile-time conformance assertion when appropriate.

Conformance MUST NOT be manufactured with a cast, assertion, unchecked conversion, or partial object.

One provider MAY implement several narrow interfaces independently. Consumers still receive only the interface they require.

### IFACE-029 — One authoritative declaration

A repository-owned interface MUST have one complete declaration in one authoritative file.

The following are prohibited:

- TypeScript declaration merging.
- Reopening an interface from another file.
- Partial interfaces.
- Repository-owned module augmentation.
- Members added through unrelated packages.
- Duplicate declarations selected by build configuration.

A reviewer MUST be able to locate the complete contract from one definition.

### IFACE-030 — External contracts remain isolated

A framework, language, or third-party interface that violates repository limits MAY be implemented only where interoperability requires it.

It MUST be isolated inside an adapter or boundary module. Repository-owned consumers MUST depend on a compliant narrow interface.

Third-party module augmentation is allowed only when all these conditions hold:

1. The external framework requires augmentation.
2. It is isolated in a dedicated boundary or declaration file.
3. It augments only an externally owned declaration.
4. It does not become a domain-facing interface.
5. Its integration is compile-time tested or otherwise validated.

External requirements do not waive the rules for repository-owned contracts or adapter-internal logic.

### IFACE-031 — Interface evolution is a compatibility change

All the following change the contract:

- Adding, removing, or renaming an operation.
- Changing an input, result, error, or generic constraint.
- Changing absence representation.
- Changing preconditions or postconditions.
- Changing side effects or completion semantics.
- Changing atomicity or idempotency.
- Changing ownership or resource cleanup.
- Changing ordering, concurrency, cancellation, or lifecycle behavior.
- Changing between synchronous and asynchronous execution.

Adding a required operation is breaking for existing implementations. An optional operation MUST NOT be used as a compatibility shortcut.

For an internal interface, all consumers, providers, documentation, and contract tests MUST change atomically.

For a published interface, incompatible behavior requires a sibling capability and an explicit migration path. Names such as `V2` are allowed only when externally versioned contracts must coexist; otherwise, use a semantic capability name.

### IFACE-032 — Every implementation runs the same contract suite

Every repository-owned interface MUST have one provider-independent contract test suite.

The suite MUST accept an implementation factory and run unchanged against every repository-owned production implementation and reusable fake.

It MUST cover every applicable observable guarantee:

- Successful outcomes.
- Expected absence.
- Every documented provider-independent failure.
- Input boundaries and preconditions.
- Postconditions.
- Side effects and completion.
- Atomicity and idempotency.
- Lifecycle and ordering.
- Ownership and cleanup.
- Cancellation.
- Concurrency.

The shared suite MAY accept a test-only provider harness that induces an expected outcome without adding controls to the production interface. A provider MUST NOT manufacture a failure category that its mechanism cannot produce. Every documented failure that a provider can produce MUST be covered either through that harness and the shared assertions or through a provider-specific test preserving the same contract meaning.

Provider-specific tests MAY supplement the contract suite but MUST NOT replace its provider-independent assertions.

The requirement applies even when only one current production implementation exists.

### IFACE-033 — Test doubles remain substitutable

A test double alone MUST NOT justify an interface.

A reusable fake or in-memory implementation MUST pass the same contract suite as production implementations.

Tests MUST NOT:

- Cast partial objects into an interface.
- Use untyped mocks.
- Omit required operations.
- Return outcomes impossible in production.
- Weaken validation or lifecycle behavior.

A per-test stub MAY implement a narrower consumer-owned interface, but it MUST honor the complete contract of that narrower interface.

### IFACE-034 — Test controls stay outside production interfaces

Production interfaces MUST NOT contain test-control operations such as:

- `seed`
- `reset`
- `getCalls`
- `setFailure`
- `advanceTime`
- `simulateError`

A fake MAY expose test-control operations through its concrete test-only type. This permission changes only their visibility; every test-only operation remains governed by the Function standard and canonical vocabulary. Production consumers MUST never receive or depend on them.

## Objective limits

For every repository-owned interface:

| Check                                                   | Required value |
| ------------------------------------------------------- | -------------: |
| Data properties in an interface                         |              0 |
| Default method bodies                                   |              0 |
| Optional operations                                     |              0 |
| Overloaded repository-owned methods                     |              0 |
| Unsupported operations                                  |              0 |
| Effective operations                                    |            1–5 |
| Positional parameters per method                        |            0–3 |
| Parameters per getter                                   |              0 |
| Parameters per setter                                   |              1 |
| Interface operations unused by a consumer               |              0 |
| Production implementations excluded from contract tests |              0 |
| Reusable fakes excluded from contract tests             |              0 |
| Authoritative declarations per interface                |              1 |

## Complete TypeScript example

```ts
/** Nominal marker for validated conversation identifiers. */
declare const CONVERSATION_ID_BRAND: unique symbol

/** Nominal marker for validated conversation titles. */
declare const CONVERSATION_TITLE_BRAND: unique symbol

/** Identifier of one conversation in validated fixed-length canonical form. */
type ConversationId = string & {
  /** Prevents interchange with other validated string identifiers. */
  readonly [CONVERSATION_ID_BRAND]: "ConversationId"
}

/** Non-empty display title validated to at most 200 Unicode code points. */
type ConversationTitle = string & {
  /** Prevents interchange with unvalidated strings. */
  readonly [CONVERSATION_TITLE_BRAND]: "ConversationTitle"
}

/** Immutable conversation data supplied to presentation strategies. */
type Conversation = {
  /** Stable identifier of the conversation. */
  readonly id: ConversationId
  /** Validated title displayed to the user. */
  readonly title: ConversationTitle
}

/** Owned human-readable presentation text. */
type FormattedConversation = {
  /** Complete text produced by the selected formatter. */
  readonly text: string
}

/**
 * Formats conversations for a consumer-selected presentation strategy.
 *
 * Implementations are ready when injected, stateless, reentrant, bounded,
 * synchronous, and free of observable side effects.
 */
interface ConversationFormatter {
  /**
   * Formats one immutable conversation without changing the input.
   *
   * @param conversation - Valid conversation to present.
   * @returns A newly owned presentation containing the validated title.
   */
  formatConversation(conversation: Conversation): FormattedConversation
}

/**
 * Owns no state to format conversations as deterministic plain text without
 * changing the input.
 *
 * @remarks Primary category: behavioral provider. Concurrency model: reentrant.
 */
class PlainTextConversationFormatter implements ConversationFormatter {
  /**
   * Implements {@link ConversationFormatter.formatConversation} as plain text.
   *
   * @param conversation - The interface-defined immutable conversation.
   * @returns The interface-defined result using plain-text syntax.
   */
  public formatConversation(conversation: Conversation): FormattedConversation {
    return { text: `${conversation.id}: ${conversation.title}` }
  }
}

/**
 * Owns no state to format conversations as deterministic Markdown headings
 * without changing the input.
 *
 * @remarks Primary category: behavioral provider. Concurrency model: reentrant.
 */
class MarkdownConversationFormatter implements ConversationFormatter {
  /**
   * Implements {@link ConversationFormatter.formatConversation} as Markdown.
   *
   * @param conversation - The interface-defined immutable conversation.
   * @returns The interface-defined result using Markdown heading syntax.
   */
  public formatConversation(conversation: Conversation): FormattedConversation {
    return { text: `# ${conversation.title}` }
  }
}

/** Dependencies required by a conversation presentation use case. */
type FormatConversationDependencies = {
  /** Consumer-selected formatting capability. */
  readonly conversationFormatter: ConversationFormatter
}

/**
 * Formats a conversation using the capability selected by composition.
 *
 * @param conversation - Valid immutable conversation to present.
 * @param dependencies - Narrow capabilities required by the use case.
 * @returns A newly owned presentation containing the validated title.
 */
function formatConversationForDisplay(
  conversation: Conversation,
  dependencies: FormatConversationDependencies
): FormattedConversation {
  return dependencies.conversationFormatter.formatConversation(conversation)
}

/** Creates one conversation formatter for contract verification. */
type ConversationFormatterFactory = () => ConversationFormatter

/** Observable violation reported by the shared formatter contract checks. */
type ConversationFormatterContractViolation =
  "input-mutated" | "output-reused" | "title-missing"

/** Production formatter factories exercised by the shared contract suite. */
const CONVERSATION_FORMATTER_FACTORIES: readonly ConversationFormatterFactory[] =
  [
    () => new PlainTextConversationFormatter(),
    () => new MarkdownConversationFormatter()
  ]

/**
 * Calculates contract violations for one formatter provider.
 *
 * @param createFormatter - Factory returning a ready formatter provider.
 * @param conversation - Valid immutable contract fixture.
 * @returns Every observable formatter-contract violation.
 */
function calculateConversationFormatterContractViolations(
  createFormatter: ConversationFormatterFactory,
  conversation: Conversation
): readonly ConversationFormatterContractViolation[] {
  const originalId = conversation.id
  const originalTitle = conversation.title
  const formatter = createFormatter()
  const firstResult = formatter.formatConversation(conversation)
  const secondResult = formatter.formatConversation(conversation)
  const violations: ConversationFormatterContractViolation[] = []

  if (
    !firstResult.text.includes(conversation.title) ||
    !secondResult.text.includes(conversation.title)
  ) {
    violations.push("title-missing")
  }
  if (conversation.id !== originalId || conversation.title !== originalTitle) {
    violations.push("input-mutated")
  }
  if (firstResult === secondResult) violations.push("output-reused")

  return violations
}

/**
 * Calculates shared contract violations across every production provider.
 *
 * @param conversation - Valid immutable contract fixture.
 * @returns Violations that the test framework must assert are empty.
 */
function calculateConversationFormatterProviderViolations(
  conversation: Conversation
): readonly ConversationFormatterContractViolation[] {
  return CONVERSATION_FORMATTER_FACTORIES.flatMap((createFormatter) =>
    calculateConversationFormatterContractViolations(
      createFormatter,
      conversation
    )
  )
}
```

The production consumer invokes every exposed operation. A test supplies one valid `Conversation` fixture to `calculateConversationFormatterProviderViolations` and asserts that the returned collection is empty. The unchanged contract calculation executes both registered production providers.

## Complete Rust example

```rust
/// Identifier of one conversation in validated fixed-length canonical form.
struct ConversationId(String);

/// Non-empty display title validated to at most 200 Unicode scalar values.
struct ConversationTitle(String);

/// Immutable conversation data supplied to formatters.
struct Conversation {
    /// Stable identifier of the conversation.
    id: ConversationId,

    /// Validated title displayed to the user.
    title: ConversationTitle,
}

/// Owned presentation text produced by a conversation formatter.
struct FormattedConversation(String);

/// Formats conversations for a consumer-selected presentation strategy.
///
/// Implementations are stateless, perform bounded synchronous work, borrow
/// their input, and return a newly owned result containing the validated title
/// without side effects.
trait ConversationFormatter {
    /// Formats one conversation under the selected presentation strategy.
    ///
    /// The returned value is newly owned, contains the validated title, and
    /// leaves the input unchanged.
    fn format_conversation(&self, conversation: &Conversation) -> FormattedConversation;
}

/// Owns no state to format conversations as deterministic plain text without
/// changing the input.
///
/// Primary category: behavioral provider. Concurrency model: reentrant.
struct PlainTextConversationFormatter;

impl ConversationFormatter for PlainTextConversationFormatter {
    /// Implements [`ConversationFormatter::format_conversation`] as plain text.
    fn format_conversation(&self, conversation: &Conversation) -> FormattedConversation {
        FormattedConversation(format!("{}: {}", conversation.id.0, conversation.title.0,))
    }
}

/// Owns no state to format conversations as deterministic Markdown headings
/// without changing the input.
///
/// Primary category: behavioral provider. Concurrency model: reentrant.
struct MarkdownConversationFormatter;

impl ConversationFormatter for MarkdownConversationFormatter {
    /// Implements [`ConversationFormatter::format_conversation`] as Markdown.
    fn format_conversation(&self, conversation: &Conversation) -> FormattedConversation {
        FormattedConversation(format!("# {}", conversation.title.0))
    }
}

/// Creates one conversation formatter for contract verification.
type ConversationFormatterFactory = fn() -> Box<dyn ConversationFormatter>;

/// Creates a ready plain-text conversation formatter.
fn create_plain_text_conversation_formatter() -> Box<dyn ConversationFormatter> {
    Box::new(PlainTextConversationFormatter)
}

/// Creates a ready Markdown conversation formatter.
fn create_markdown_conversation_formatter() -> Box<dyn ConversationFormatter> {
    Box::new(MarkdownConversationFormatter)
}

/// Production formatter factories exercised by the shared contract suite.
const CONVERSATION_FORMATTER_FACTORIES: [ConversationFormatterFactory; 2] = [
    create_plain_text_conversation_formatter,
    create_markdown_conversation_formatter,
];

/// Formats a conversation using the capability selected by composition.
///
/// Returns a newly owned presentation containing the validated title.
fn format_conversation_for_display(
    conversation: &Conversation,
    conversation_formatter: &dyn ConversationFormatter,
) -> FormattedConversation {
    conversation_formatter.format_conversation(conversation)
}

/// Observable violation reported by the shared formatter contract checks.
enum ConversationFormatterContractViolation {
    /// The result omitted the validated conversation title.
    TitleMissing,
}

/// Calculates contract violations for one formatter provider.
fn calculate_conversation_formatter_contract_violations(
    create_formatter: ConversationFormatterFactory,
    conversation: &Conversation,
) -> Vec<ConversationFormatterContractViolation> {
    let formatter = create_formatter();
    let result = formatter.format_conversation(conversation);

    if result.0.contains(&conversation.title.0) {
        Vec::new()
    } else {
        vec![ConversationFormatterContractViolation::TitleMissing]
    }
}

/// Calculates shared contract violations across every production provider.
fn calculate_conversation_formatter_provider_violations(
    conversation: &Conversation,
) -> Vec<ConversationFormatterContractViolation> {
    CONVERSATION_FORMATTER_FACTORIES
        .into_iter()
        .flat_map(|create_formatter| {
            calculate_conversation_formatter_contract_violations(create_formatter, conversation)
        })
        .collect()
}
```

The production consumer invokes the trait's only operation. A test passes one valid `Conversation` fixture to `calculate_conversation_formatter_provider_violations` and asserts that the returned vector is empty. The unchanged calculation executes both registered production providers.

## SOLID mapping

- **SRP:** `IFACE-005` and `IFACE-006`.
- **OCP:** `IFACE-003`, `IFACE-023`, `IFACE-025`, and `IFACE-031`.
- **LSP:** `IFACE-013` through `IFACE-023`, `IFACE-032`, and `IFACE-033`.
- **ISP:** `IFACE-006` through `IFACE-008`.
- **DIP:** `IFACE-004` and `IFACE-024`.

## Verification checklist

An interface is compliant only when every applicable answer is “yes”:

- [ ] Is data represented by a type and object behavior by an interface-equivalent?
- [ ] Does the interface contain required instance methods or behaviorally evidenced explicit accessors only?
- [ ] Do a current production consumer, known provider, and valid abstraction reason exist?
- [ ] Does the high-level consumer or stable public API own the interface?
- [ ] Does it represent exactly one capability?
- [ ] Does it expose between one and five effective operations?
- [ ] Does every consumer use every exposed operation?
- [ ] Does every provider support every operation without optional or fallback behavior?
- [ ] Does the name identify the capability without language or implementation markers?
- [ ] Does every method satisfy the Function standard and every accessor satisfy the Class accessor rules?
- [ ] Do signatures use explicit compliant domain data types?
- [ ] Do the interface and every operation have authoritative API documentation?
- [ ] Are all preconditions encoded or documented exactly?
- [ ] Are all successful postconditions exact?
- [ ] Are absence and failure representations provider-independent?
- [ ] Are side effects, atomicity, idempotency, and completion explicit?
- [ ] Do all providers preserve the synchronous or asynchronous contract?
- [ ] Is every potentially unbounded operation explicitly cancellable?
- [ ] Is every provider ready when exposed?
- [ ] Is ownership and release defined for every returned resource?
- [ ] Are mutable implementation details prevented from escaping?
- [ ] Can every provider satisfy the complete contract without behavioral differences?
- [ ] Are implementation identity and runtime capability probing absent from consumers?
- [ ] Are dependencies supplied explicitly by the composition root?
- [ ] Can a new provider be added without changing consumer policy?
- [ ] Does interface composition preserve narrow capability boundaries?
- [ ] Are generics and associated types necessary, constrained, and operation-linked?
- [ ] Does every production provider declare conformance explicitly?
- [ ] Does the interface have one authoritative declaration?
- [ ] Are externally imposed contracts isolated behind an adapter?
- [ ] Are compatibility consequences handled for every interface change?
- [ ] Does one contract suite run against every production provider and reusable fake?
- [ ] Do all test doubles remain substitutable?
- [ ] Are test controls absent from production interfaces?
