# Class

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines the mandatory construction rules for repository-owned classes and semantic class equivalents.

## Definition

A class is an instance-based implementation construct that owns behavior. It exists to preserve a private invariant, own a resource or dependency across calls, implement a current behavioral interface, or satisfy an externally required class contract.

Classification is semantic rather than syntactic:

- A TypeScript, Java, C#, or Python class used as a behavior owner follows this chapter.
- A Rust struct with private implementation state and inherent or trait behavior follows this chapter.
- A Go receiver type that owns behavior follows this chapter.
- A record, struct, data class, or class-shaped declaration used only to carry data follows the [Type](./TYPE.md) chapter instead.

Renderer-managed state or lifecycle attached to a function or template component does not by itself create a repository-owned Class construct. An actual repository-owned instance that retains state, dependencies, resources, identity, or lifecycle across calls remains a Class construct and MUST follow this chapter.

| Concern                                                 | Required construct                                              |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Data, attributes, configuration, payloads, or snapshots | Type, record, struct, data class, or equivalent value construct |
| Substitutable behavioral contract                       | Interface, trait, protocol, or equivalent capability construct  |
| Parameter-only behavior                                 | Module-level or namespace-level function                        |
| Private state, resource, or dependency-backed behavior  | Class or semantic class equivalent                              |
| Externally mandated subclass                            | Isolated framework or runtime adapter                           |

A language keyword does not override this boundary. Compiler acceptance does not make a data container, static namespace, or unrelated method collection a compliant class.

## Construction recipe

Before creating a class:

1. Write one sentence: “Owns `[state/resource/dependencies]` to provide `[capability]` while preserving `[invariant/lifecycle]`.”
2. Identify its one primary class category.
3. Confirm that `CLASS-001` provides a current instance-level reason.
4. Move data-only representation to compliant types.
5. Move parameter-only behavior to compliant functions.
6. Identify every current production consumer and justified interface.
7. Remove public operations not required by those consumers or contracts.
8. Name the class after its owner or concrete mechanism and capability.
9. Supply every dependency explicitly and classify its ownership.
10. Keep the ownership graph acyclic.
11. Choose a pure direct constructor or a failure-safe effectful factory.
12. Ensure the caller receives a fully ready instance.
13. Define one private state representation and its invariant.
14. Define legal transitions and their failure and cancellation outcomes.
15. Define property access through compliant accessors when applicable.
16. Declare one concurrency model.
17. Define resource cleanup and post-cleanup behavior when applicable.
18. Use composition and interfaces instead of repository-owned inheritance.
19. Check every objective size limit.
20. Add complete API documentation.
21. Add the required construction, state, lifecycle, concurrency, and contract tests.

## Class categories

Every class MUST have one primary category.

### Invariant owner

Preserves one private state model across operations.

Example: `DraftEditor`.

### Resource owner or boundary adapter

Translates one external mechanism or owns one external resource, client, process, database, or lifecycle. A boundary adapter MAY borrow the mechanism client whose contract it translates.

Example: `SqliteConversationStore`.

### Behavioral provider

Provides a stateless implementation of a currently justified interface under `IFACE-003`.

Example: `MarkdownConversationFormatter`.

### Dependency-backed policy owner

Retains narrow collaborators to provide one stable application or domain capability.

Example: `ConversationImportCoordinator`.

### Framework adapter

Exists because an external framework or runtime requires a class or subclass.

Example: `FastifyAuthenticationPlugin`.

## Example scope

Examples use TypeScript and Rust to show the same language-independent rules. Abbreviated examples may omit surrounding declarations, but omitted repository code remains subject to every applicable standard.

## Mandatory rules

### CLASS-001 — Classes require an instance-level reason

A repository-owned class is allowed only when at least one of these conditions holds:

1. It preserves a private invariant across calls.
2. It owns mutable state or a resource lifecycle across calls.
3. It retains narrow injected dependencies to provide one cohesive capability.
4. It implements a current behavioral interface justified by `IFACE-003`.
5. An external framework or runtime requires a class.

A class MUST expose at least one instance operation. Construction alone does not justify a class.

The following are prohibited:

- Data-only, DTO, configuration, props, state, payload, or snapshot classes.
- Getter-and-setter-only containers.
- Static-only utility classes.
- Classes used as namespaces.
- Classes created only to group related functions.
- Classes created for hypothetical implementations or test mocking.

```ts
// Noncompliant: this is data.
class Conversation {
  constructor(
    public readonly id: ConversationId,
    public readonly messages: readonly Message[]
  ) {}
}

// Compliant
type Conversation = {
  readonly id: ConversationId
  readonly messages: readonly Message[]
}
```

### CLASS-002 — One class owns one responsibility

A class MUST be describable by one ownership sentence:

> Owns `[state/resource/dependencies]` to provide `[one capability]` while preserving `[one invariant/lifecycle]`.

Every field and method MUST be necessary for that sentence.

A class MUST be split when operations differ by domain purpose, actor, policy, permission, transaction boundary, independent lifecycle, resource, abstraction level, or category of reason to change.

These are mandatory split signals:

- Groups of methods use disjoint groups of fields.
- One behavior can exist without the other.
- One behavior changes for a different business or external-system reason.
- Methods share only a broad noun or one vendor client.
- One operation coordinates policy while another implements low-level mechanics.

Sharing a dependency does not establish cohesion. Chat streaming and title generation remain separate capabilities even when both use one OpenAI client.

This is the class-level application of SRP.

### CLASS-003 — Every class has one primary category

Every class MUST select exactly one primary category from this chapter.

When several descriptions appear applicable, the first matching condition in this precedence order determines the primary category:

1. An external framework requires the class form: **framework adapter**.
2. The class crosses an external mechanism boundary or owns a resource: **resource owner or boundary adapter**.
3. The class owns a mutable domain or application invariant: **invariant owner**.
4. The class retains collaborators to coordinate high-level policy: **dependency-backed policy owner**.
5. The class is a stateless implementation of a justified interface: **behavioral provider**.

Owning a lifecycle or implementing an interface MAY accompany the primary category only when both serve the same ownership sentence.

A category MUST NOT be selected merely to excuse an otherwise data-only, static-only, or mixed-responsibility class.

The class API documentation MUST state the selected category.

### CLASS-004 — Names identify the owner or mechanism

A class name MUST identify either:

- The state, resource, or policy it owns.
- The concrete mechanism followed by the capability it provides.

Compliant examples include `BackendProcess`, `DraftEditor`, `SqliteConversationStore`, `OpenAiChatStreamer`, `MarkdownConversationFormatter`, and `SystemClock`.

The following standalone names and suffixes are prohibited unless the word is an established domain term with a narrower documented meaning:

- `Service`
- `Manager`
- `Helper`
- `Utility` or `Utils`
- `Processor`
- `Handler`
- `Provider`
- `Controller`

The suffixes `Impl`, `Implementation`, `Default`, `Concrete`, `Base`, `Abstract`, and numeric versions are always prohibited.

`Data`, `Info`, `Object`, `Class`, and `Model` MUST NOT replace a precise domain name.

A concrete implementation of an interface MUST identify its mechanism:

```ts
// Noncompliant
class ConversationStoreImpl implements ConversationReader {
  // ...
}

// Compliant
class SqliteConversationStore implements ConversationReader {
  // ...
}
```

One class implementing related interfaces names their shared mechanism and owned concept rather than concatenating interface names.

### CLASS-005 — Public surface requires current evidence

Every public operation MUST be required by at least one current production consumer, approved behavioral interface, external framework contract, or standard lifecycle protocol.

Test convenience, anticipated callers, symmetry, and “might be useful” do not justify a public member.

Visibility MUST default to private. A class MUST NOT expose a protected repository-owned member.

Deprecated aliases count as public operations until removed. Unused public operations MUST be removed.

An externally required member MUST be isolated in the framework adapter and MUST NOT make unrelated implementation details public.

### CLASS-006 — Objective limits are mandatory

A repository-owned class MUST remain within every limit:

| Measurement                             | Maximum |
| --------------------------------------- | ------: |
| Retained collaborators                  |       5 |
| Instance fields                         |       7 |
| Public operations                       |       7 |
| Total executable members                |      15 |
| Total executable lines inside the class |     200 |

Counting rules:

- A **public operation** is any constructor, factory, method, getter, setter, or lifecycle operation intentionally invocable by a production consumer outside the class implementation. Count semantic consumer access regardless of export keywords, module visibility, or language syntax. Interface- or trait-required operations and composition-root construction operations are public operations.
- A **retained collaborator** is a stored callable, behavioral capability, external client, resource handle, clock, generator, or other active dependency used after construction. Count each independently supplied capability, including callbacks and separate capabilities implemented by one object. Immutable domain data and passive configuration values are fields but are not collaborators.
- Each public constructor, class-associated factory, method, getter, setter, and lifecycle operation counts as one public operation.
- A public module-level factory returning the class also counts as one class construction operation for the seven-operation public-surface limit.
- Each accessor counts separately. One getter-and-setter pair counts as two operations.
- Every overload signature counts as one public operation.
- Constructors, methods, accessors, factories, and lifecycle methods count toward total executable members regardless of visibility.
- A module-level factory is a Function construct: it does not count as an executable class member or toward the class's 200 executable lines.
- One overload implementation body counts once toward executable members.
- Executable-line counting uses `FUNC-013`: signatures, comments, blank lines, and delimiter-only lines do not count.
- Each retained collaborator counts separately even when hidden inside a dependency object.
- A cohesive structured state value counts as one field.
- Configuration values are not collaborators, but retained configuration counts toward the field limit.

A class MUST NOT group unrelated fields, introduce pass-through wrappers, or fragment meaningful operations to evade a limit.

An externally required adapter MAY exceed the public-operation, executable-member, and 200-executable-line limits only when the external contract itself imposes the excess and cannot be split across supported adapter types. Only exact required members and their minimal delegating bodies are exempt. Every repository-designed member remains inside the limits, and the adapter MUST add no unrelated operation.

### CLASS-007 — One authoritative declaration defines the class

A repository-owned class MUST have an explicit name and one complete authoritative declaration in one source file.

The following are prohibited:

- Anonymous repository-owned classes.
- Partial classes or declaration merging.
- Runtime prototype modification.
- Methods attached outside the class declaration or language-defined implementation blocks.
- Public function-valued fields used instead of methods.
- Repository-owned mixins.

Every generic parameter on a class MUST satisfy `TYPE-013`, `TYPE-014`, and `TYPE-015`.

Language-defined implementation blocks are part of the authoritative declaration. Rust `impl` blocks and Go receiver methods are allowed only in the same source file as the authoritative type. Separate co-located blocks MAY distinguish inherent behavior from individual interface or trait conformances. Repository-owned methods MUST NOT be added from another file or module.

Externally required declaration merging, runtime hooks, or augmentation MUST remain isolated in an adapter and MUST NOT become a domain construction pattern.

### CLASS-008 — Dependencies are explicit and narrow

Every retained collaborator MUST be supplied through the constructor or approved factory.

A high-level class MUST depend on the smallest domain-facing interface justified by `IFACE-003`. A boundary adapter MAY receive its mechanism-specific client at the composition boundary.

A class MUST NOT:

- Resolve a dependency from global state.
- Use a service locator.
- Read hidden environment or configuration state.
- Construct a low-level provider inside high-level policy.
- Retain an entire configuration or dependency container when it uses only selected values.
- Accept a broad dependency only because the provider exposes additional operations.

Every retained dependency reference MUST be private and immutable unless lifecycle ownership requires one documented state transition.

A direct concrete dependency is allowed when no interface is justified. SOLID MUST NOT create a speculative interface.

### CLASS-009 — The ownership graph is acyclic

The ownership graph formed by repository-owned class instances MUST be acyclic.

A class MUST NOT:

- Own itself directly or indirectly.
- Self-register in a global container.
- Retain a strong back-reference that creates a lifecycle cycle.
- Require mutually recursive construction.

A non-owning back-reference MUST use an explicit weak reference, callback, event, identifier, or narrow interface and MUST document which instance owns the relationship.

Shared dependencies MAY form a directed acyclic graph when their shared lifecycle owner is explicit.

### CLASS-010 — Direct constructors are pure

A direct constructor MAY only:

- Validate already-provided values.
- Store explicit narrow dependencies.
- Initialize private in-memory state.
- Establish invariants without external effects.

A direct constructor MUST NOT:

- Perform filesystem, database, network, process, or vendor API operations.
- Start background work.
- Register callbacks or publish `this` or `self`.
- Call public, virtual, abstract, or overridable behavior.
- Resolve hidden dependencies.
- Leave a placeholder, sentinel, or uninitialized field.

A constructor MUST fail before publishing the instance when input cannot establish the invariant.

### CLASS-011 — Effectful creation uses a failure-safe factory

Filesystem, database, network, process, vendor, asynchronous, or otherwise fallible external acquisition MUST occur in a named factory.

The factory MAY be module-level or a static or associated construction operation. Its name MUST follow `FUNC-003`.

The factory MUST:

1. Validate inputs.
2. Acquire dependencies and resources.
3. Complete mandatory preparation.
4. Construct the ready instance.
5. Release every acquired resource when any later step fails or is cancelled.
6. Return the ready object or one explicit failure contract.

```ts
class SqliteConversationStore {
  /** Owned SQLite database used for conversation persistence. */
  readonly #database: DatabaseSync

  /** Stores an already prepared owned database. */
  private constructor(database: DatabaseSync) {
    this.#database = database
  }

  /**
   * Opens and prepares a SQLite conversation store.
   *
   * @param databaseFilePath - Filesystem location of the SQLite database.
   * @returns A ready store that owns the opened database.
   * @throws If opening or migration fails. Any opened database is closed first.
   */
  public static open(databaseFilePath: PathLike): SqliteConversationStore {
    const database = new DatabaseSync(databaseFilePath)

    try {
      migrateConversationDatabase(database)
      return new SqliteConversationStore(database)
    } catch (error) {
      database.close()
      throw error
    }
  }
}
```

### CLASS-012 — Instances are ready when exposed

The caller MUST receive either a fully ready instance or a failure.

Mandatory post-construction `init`, `initialize`, `setup`, `prepare`, or `configure` calls are prohibited.

A valid initial lifecycle state such as `stopped` is allowed when every public operation has documented behavior in that state. A later `start` operation is then a real state transition, not hidden initialization.

Fallible lazy initialization is prohibited. Pure private memoization is governed by `CLASS-020`.

An instance MUST NOT be injected, returned, registered, or captured before readiness is complete.

### CLASS-013 — Representation is private and minimal

A class-equivalent behavior owner MUST have zero public instance fields and zero protected fields.

Every implementation field MUST use the strongest available privacy mechanism.

A field binding MUST be immutable unless reassignment is necessary for the documented state machine.

Each field MUST serve the ownership sentence. A class MUST store only the state, configuration, dependency, or resource required after construction.

Public property access uses the accessor rules in this chapter rather than public fields.

### CLASS-014 — State excludes invalid combinations

Every mutable value MUST have one owner and belong to one documented class invariant.

Related state MUST use one structured state representation rather than independent Boolean flags, nullable fields, or mutually dependent values.

Invalid combinations MUST be unrepresentable under `TYPE-005`.

```ts
// Noncompliant: running can disagree with pid.
type BackendProcessStatus = {
  readonly running: boolean
  readonly pid: number | undefined
}

// Compliant
type BackendProcessStatus =
  | { readonly status: "stopped" }
  | { readonly status: "running"; readonly pid: ProcessId }
```

The class MUST define one authoritative state value for each invariant.

### CLASS-015 — Transitions preserve the invariant atomically

Every state-changing operation MUST validate its precondition and commit all related changes as one transition.

The complete invariant MUST hold:

- When every public operation begins.
- Before an `await`, callback, event, or external call can expose the object.
- When the operation succeeds.
- When the operation returns an expected failure.
- When the operation throws.
- When the operation is cancelled.

A method MUST compute and validate a replacement state before assigning it when doing so prevents partial mutation.

A check and the mutation that depends on it MUST share one atomic synchronization boundary.

### CLASS-016 — Mutable representation never escapes

A class MUST NOT expose mutable internal representation through a field, accessor, method result, collection, iterator, buffer, lock, resource handle, SDK client, database object, or mechanism object.

A mutable input MUST be copied or accepted through an explicitly documented ownership transfer before the class retains it.

A returned value MUST be:

- Deeply immutable.
- An independent copy.
- A named immutable snapshot.
- A resource whose ownership transfer and cleanup are explicit.
- A narrow behavioral capability controlling allowed mutation.

A class MUST NOT return `this` solely to enable fluent mutation.

### CLASS-017 — Accessors represent genuine local properties

A language with property accessors MUST use its native getter or setter syntax for genuine property reads and assignments.

JavaScript and TypeScript MUST use `get propertyName()` and `set propertyName(value)` rather than `getPropertyName()` and `setPropertyName(value)` for compliant local properties.

A language without property syntax MAY use its conventional accessor method form. For example, Rust uses `content()` and `set_content(value)`. Such methods remain accessors under `CLASS-018` and `CLASS-019`.

An accessor is allowed only when all these conditions hold:

1. The provider qualifies under `CLASS-001` for a reason independent of exposing the accessor.
2. The property belongs to the provider's live invariant across calls.
3. A getter observes the property, and any setter changes that same property.
4. Replacing the provider with an independent data record would lose required state identity, behavior, or lifecycle.

An accessor is prohibited when the operation:

- Is asynchronous.
- Performs external I/O.
- Is expensive or potentially unbounded.
- Represents a lifecycle transition or domain command.
- Requires parameters beyond the assigned value.
- Has an expected operational failure contract.
- Emits an event or starts background work.

Such behavior MUST use a method with canonical `FUNC-003` vocabulary.

A class whose only behavior is property access remains a prohibited data container under `CLASS-001`.

### CLASS-018 — Getters are synchronous local queries

A getter MUST:

- Accept no parameters.
- Read already-owned in-memory state.
- Complete synchronously with bounded work.
- Be deterministic for the current state.
- Produce no observable side effect.
- Use a noun property name.
- Return an immutable value, snapshot, or independent copy.

A getter MUST NOT expose a mutable collection, resource, collaborator, or mechanism object.

Pure private memoization MAY occur under `CLASS-020` when cache population cannot change observable behavior or introduce failure.

### CLASS-019 — Setters are atomic local assignments

A setter MUST:

- Accept exactly one value.
- Have a corresponding getter for the same property.
- Use the same property type as its getter.
- Accept a trusted value type whose complete valid set preserves the property invariant.
- Complete synchronously.
- Check any runtime contract assertion before mutation.
- Preserve the full class invariant atomically.
- Return no value.
- Preserve the same observable state when the same value is assigned repeatedly.

A setter MUST NOT perform I/O, emit events, start background work, change lifecycle state, or represent a domain command.

Invalid untrusted input MUST be parsed before it reaches a setter. A setter MAY throw synchronously for a programming-contract violation that cannot be represented by its declared trusted type; that is not an expected operational outcome and MUST leave state unchanged.

An assignment that can validly be refused because of lifecycle, authorization, capacity, I/O, or another expected condition MUST use a named method with an explicit failure contract instead.

### CLASS-020 — Derived and cached state has one source of truth

A value derivable from authoritative state MUST NOT also be stored unless it is a justified cache.

A cache is allowed only when:

- Its computation is pure.
- It is private.
- Every authoritative-state mutation invalidates or updates it.
- Cache presence does not change observable behavior.
- Cache population cannot introduce failure or a lifecycle requirement.

A cache MUST NOT become a second source of truth.

Hidden fallible lazy initialization, ambient global caches, and stale-on-error fallback behavior are prohibited.

### CLASS-021 — Methods follow the Function standard

Every constructor, factory, method, accessor body, callback, and lifecycle operation MUST satisfy every applicable `FUNC-*` rule.

`FUNC-020` is authoritative for deciding whether behavior may be an instance method. A class MUST relocate behavior that fails that rule instead of retaining it for organizational convenience.

`FUNC-003` owns the naming exceptions for native constructors and compliant accessors. Every named factory and non-accessor method remains subject to canonical vocabulary.

Private visibility does not waive `CLASS-002` or `FUNC-020`.

Method syntax MUST be used for operations. A public arrow-function field or function-valued property is prohibited.

### CLASS-022 — Public APIs do not expose mechanisms

A domain or application class MUST use domain-facing data types and capabilities at its public boundary.

It MUST NOT expose:

- Vendor SDK request or result types.
- Database rows, statements, sessions, or connections.
- Framework request or response objects.
- Filesystem handles when location is not part of the domain contract.
- Transport status codes or headers.
- Mechanism-specific errors.
- Raw locks, tasks, or process handles.

Boundary adapters translate between mechanism contracts and compliant domain types.

Every public parameter and result type MUST be explicit under `TYPE-018`.

### CLASS-023 — Every class declares one concurrency model

Every class MUST document exactly one mutually exclusive model:

1. **Reentrant:** the class owns no mutable instance state, and every retained collaborator permits the same operations to overlap without class-owned synchronization.
2. **Single-owner:** the class or a retained resource or collaborator requires exclusive or thread-affine access, and construction and retention confine the instance to one thread, task, actor, or event-loop owner.
3. **Serialized:** shared callers are accepted, but the class permits exactly one operation at a time through one queue or synchronization boundary.
4. **Concurrent:** shared callers are accepted, and a class-owned synchronization boundary permits a documented proper subset of operations to overlap while exclusive updates protect each mutable invariant.

A class MUST NOT claim stronger guarantees than its retained dependencies provide.

A single-owner class MUST be constructed and retained inside a boundary that prevents concurrent access. Documentation alone is not enforcement.

A stateless provider is reentrant only when every collaborator it invokes is reentrant for the same operations.

### CLASS-024 — Suspension and failure preserve valid state

Before suspending, a state-changing operation MUST commit an explicit valid transition state such as `starting`, `stopping`, or `closing`.

After suspension, the operation MUST revalidate any state or version that another operation could have changed.

Failure and cancellation MUST settle the transition into one documented valid state.

Parallel operations MUST NOT observe a partial transition.

Reentrant calls MUST either be supported or rejected with one documented failure. They MUST NOT deadlock or silently overwrite state.

Every background task MUST have one lifecycle owner that observes terminal success or failure.

### CLASS-025 — Critical sections exclude unknown or unbounded work

One invariant MUST use one synchronization strategy.

A synchronous critical section MAY contain only:

- In-memory state inspection or mutation.
- Bounded, non-suspending operations on the protected resource.

While holding a synchronous lock, code MUST NOT:

- `await`.
- Perform unbounded filesystem, database, network, or process waiting.
- Invoke callbacks or consumer-provided code.
- Emit events.
- Call an unknown interface implementation.
- Acquire another lock without one documented global lock order.

Callbacks and events MUST receive an immutable snapshot only after the invariant is committed and the lock is released.

An asynchronous serialization queue MAY span an `await` when serial execution is its declared purpose. Queued code MUST NOT synchronously re-enter the same queue.

### CLASS-026 — Resource ownership is explicit

Every retained resource or disposable dependency MUST be documented as exactly one of:

- **Owned:** the class alone releases it.
- **Borrowed:** another owner controls its lifecycle.
- **Shared:** the class owns one share, lease, or reference token, while an explicit shared-ownership mechanism controls release of the underlying resource.

A class MUST NOT dispose a borrowed resource, create multiple exclusive owners, or transfer ownership silently.

An owned resource or an owned shared-ownership token that requires release justifies a cleanup operation. A borrowed reference does not.

A resource MUST NOT rely on garbage collection or process termination for normal cleanup.

Per-operation resource transfer also follows `FUNC-018` and `IFACE-020` when applicable.

### CLASS-027 — Cleanup is deterministic, idempotent, and complete

A resource-owning class MUST use the language's standard deterministic disposal protocol when available.

It MUST expose exactly one repository-owned cleanup entry point unless an external contract requires another name.

Cleanup MUST:

- Be idempotent.
- Make concurrent cleanup calls join the same completion.
- Prevent new owned work after cleanup begins.
- Cancel and await owned background work.
- Release resources in reverse acquisition order.
- Attempt every required release when an earlier release fails.
- Preserve or aggregate every cleanup failure.
- Complete only after owned work and resources reach their terminal state.

A class without an owned cleanup responsibility MUST NOT expose a cleanup-shaped `close`, `dispose`, `shutdown`, `terminate`, `Drop`, or equivalent no-op member. A real restartable state transition such as `stopEditing` or `stopStreaming` is allowed when it changes the documented invariant and is not presented as resource cleanup.

Multiple public cleanup aliases are prohibited.

### CLASS-028 — Lifecycle state and background work are terminal

A resource owner whose cleanup can overlap operations MUST represent at least:

```text
ready -> closing -> closed
```

`ready` permits documented operations. `closing` rejects new operations and waits for owned work. `closed` permits only documented status inspection and repeated cleanup.

Every non-lifecycle operation after closure MUST produce one canonical closed-state failure before accessing the resource.

A failed cleanup MUST leave one documented terminal state and MUST NOT silently return the object to `ready`.

An infallible synchronous destructor MAY be the primary protocol only when it can complete all cleanup. Fallible or asynchronous cleanup requires an explicit operation. A finalizer MAY be a last-resort safety net but MUST NOT be the primary mechanism.

### CLASS-029 — Composition replaces repository-owned inheritance

A repository-owned class MUST NOT:

- Extend another repository-owned class.
- Act as an abstract base class.
- Be designed for subclassing.
- Use inheritance to share implementation.
- Use protected extension hooks.
- Use mixins, prototype mutation, monkey-patching, or partial declarations for reuse.

Classes MUST be `final`, `sealed`, or equivalent where the language can enforce it.

Use interfaces for substitutable behavior, collaborators for reusable stateful behavior, functions for stateless reuse, and closed data variants for finite alternatives.

This is the class-level application of OCP and LSP.

### CLASS-030 — External inheritance remains isolated

A class MAY directly extend an external framework or runtime base only when the external contract requires subclassing.

The subclass MUST:

- Remain at the integration boundary.
- Extend only the required external base.
- Override only required operations.
- Delegate domain policy to compliant collaborators.
- Add no protected state or repository-owned extension hooks.
- Preserve the complete parent contract.
- Prevent further repository-owned subclassing.
- Avoid overridable calls during construction.

An external base MUST NOT become a repository-owned intermediate base.

Language error bases and framework callback bases are included only when their contracts require inheritance.

### CLASS-031 — Multiple interfaces share one owner

One class MAY implement several narrow interfaces only when every interface operates on the same invariant, resource, transaction boundary, lifecycle, and category of reason to change.

Each consumer MUST receive only the interface it requires under `IFACE-007`.

Sharing one provider, client, or broad topic does not justify combining interfaces.

For a declared extension axis, adding a provider may change only the new provider, composition-root registration, contract-suite registration, and provider-specific tests. Consumer policy and existing providers MUST remain unchanged.

Every declared conformance MUST satisfy `IFACE-028`, and every implementation MUST remain substitutable under `IFACE-022`.

### CLASS-032 — Static members are narrowly limited

A repository-owned class MAY contain only these static members:

- Named construction factories.
- Deeply immutable constants whose narrowest valid scope is the class.
- Hooks required by an external framework contract.

A static or associated factory MUST receive every dependency explicitly.

The following are prohibited:

- Static mutable state.
- Singleton instances stored on the class.
- Global registries or caches.
- Service locators.
- Static utility operations.
- Hidden environment or configuration access.
- Static methods used only to namespace parameter-only functions.

An application-scoped singleton lifetime is allowed when the composition root owns one ordinary instance. A static global singleton is prohibited.

Class-scoped constants remain subject to every `CONST-*` rule.

### CLASS-033 — Object identity is not domain equality

A class instance has operational identity for its lifetime.

A repository-owned class MUST NOT implement domain value equality, ordering, or hashing.

Consumers MUST NOT compare class instances to determine domain equality. Domain identity uses an explicit immutable identifier type, and domain value equality compares compliant data types through a focused function.

Consumers of an interface MUST NOT branch on instance identity or concrete implementation.

The composition or lifecycle owner MAY use object identity internally to track the exact instance it created. That identity MUST NOT cross a domain, persistence, or API boundary.

### CLASS-034 — Behavior owners are not copied

A class that owns behavior, state, dependencies, or resources MUST NOT be:

- Cloned.
- Shallow-copied.
- Deep-copied.
- Spread into another object.
- Duplicated through reflection.
- Used as a prototype for another instance.

When a resource supports meaningful duplication, an explicit operation MUST define the new owner, lifecycle, independence, and failure behavior.

`clone` or a language-equivalent copying contract is allowed only when an external contract requires that exact semantic operation and the implementation proves independent ownership.

Data values and snapshots follow the Type chapter and MAY define their own copy semantics.

### CLASS-035 — Serialization uses immutable snapshots

A class instance MUST NOT be serialized directly.

State crosses a serialization boundary only through a named immutable snapshot type.

A snapshot MUST:

- Represent one internally consistent point in time.
- Contain no class instance, resource, collaborator, lock, or mechanism object.
- Expose no mutable back-reference.
- Satisfy every applicable `TYPE-*` rule.

Reconstruction MUST parse and validate untrusted serialized data and then use the approved constructor or factory.

Generic reflection-based class serialization, `JSON.stringify(instance)` as a persistence contract, private field persistence, and deserialization that bypasses validation are prohibited.

An external serialization framework MUST be isolated behind an adapter that translates to compliant data types.

### CLASS-036 — Documentation defines the complete class contract

Every class MUST have API documentation stating:

- Its primary category.
- Its ownership sentence.
- Its invariant.
- Its concurrency model.
- Resource ownership and lifecycle when applicable.

Every constructor, factory, field, accessor, method, and lifecycle operation MUST have JSDoc, rustdoc, or the language-equivalent API documentation.

Documentation MUST describe every applicable precondition, postcondition, ownership transfer, state transition, side effect, completion point, expected failure, cancellation rule, and concurrency guarantee.

An interface implementation MUST reference the authoritative interface contract. Required documentation tags MAY identify interface-defined inputs and results by reference; additional prose MUST be limited to implementation-specific behavior. Implementation documentation MUST NOT redefine, restate incompatibly, or weaken the interface contract.

TypeScript and JavaScript documentation MUST also satisfy [`docs/JSDOC.md`](../JSDOC.md).

### CLASS-037 — Class contract changes are compatibility changes

Changing any of these is a compatibility change:

- Constructor or factory contract.
- Public method or accessor.
- Input, result, error, absence, or snapshot type.
- Side effect or completion point.
- Ownership or lifecycle behavior.
- Concurrency or reentrancy guarantee.
- Implemented interface.
- Synchrony versus asynchrony.

Private representation MAY change only when every observable contract remains identical.

An internal compatibility change MUST update every consumer, interface, documentation reference, composition binding, contract suite, and implementation test atomically.

Adding a public operation is a compatibility change and still requires current evidence under `CLASS-005`.

### CLASS-038 — Tests cover the complete class contract

Class tests MUST use public behavior and cover every applicable case:

| Area              | Required coverage                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Construction      | Valid creation and every documented validation failure                                                   |
| Effectful factory | Failure after every acquisition step and complete cleanup                                                |
| Public operation  | Success, each expected failure, and every legal state                                                    |
| Getter            | Returned immutability and snapshot consistency                                                           |
| Setter            | Valid and repeated assignment, invariant preservation, and any applicable programming-contract violation |
| Transition        | Success, failure, cancellation, and invalid transition                                                   |
| Lifecycle         | First, repeated, and concurrent cleanup plus post-close calls                                            |
| Concurrency       | Overlapping operations at every shared state transition                                                  |
| Interface         | Shared contract suite against every implementation                                                       |
| Encapsulation     | No mutable input, output, dependency, or resource leakage                                                |

Every method also follows `FUNC-024`. Every interface implementation runs the shared suite required by `IFACE-032`.

Concurrency tests MUST use controllable barriers, queues, clocks, or schedulers rather than timing sleeps.

### CLASS-039 — Tests do not distort class design

Tests MUST NOT:

- Access private members through reflection, casts, or unchecked conversion.
- Subclass a class to expose internals.
- Assert private method calls.
- Add production fields or methods for test control.
- Mock a concrete class when a behavioral interface exists.
- Create an interface only to mock one class.
- Bypass the constructor, factory, invariant, or lifecycle.
- Depend on a leaked mechanism object.

Tests MUST control effects through explicit dependencies, approved interfaces, and public operations.

A reusable fake MUST honor every interface and lifecycle contract it implements.

## Objective limits

| Property                           | Required value |
| ---------------------------------- | -------------: |
| Primary category                   |              1 |
| Ownership sentence                 |              1 |
| Public instance fields             |              0 |
| Protected fields or methods        |              0 |
| Static mutable fields              |              0 |
| Repository-owned base classes      |              0 |
| Repository-owned inheritance depth |              0 |
| Authoritative declarations         |              1 |
| Retained collaborators             |            0–5 |
| Instance fields                    |            0–7 |
| Public operations                  |            1–7 |
| Total executable members           |           1–15 |
| Total executable lines             |          0–200 |
| Concurrency models                 |              1 |
| Public cleanup entry points        |            0–1 |
| Test-only production members       |              0 |

Externally required adapter exceptions are limited to the exact declarations and minimal delegating bodies imposed by the external contract and remain governed by `CLASS-006` and `CLASS-030`.

## Complete TypeScript example

```ts
/** Immutable text owned by a draft editor. */
type DraftContent = {
  /** Complete draft text. */
  readonly value: string
}

/** Current editing lifecycle of one draft editor. */
type DraftStatus = "idle" | "editing"

/** Private authoritative state of one draft editor. */
type DraftState =
  | {
      /** The editor has no active editing transaction. */
      readonly status: "idle"
      /** Last committed draft content. */
      readonly content: DraftContent
    }
  | {
      /** The editor has one active editing transaction. */
      readonly status: "editing"
      /** Current uncommitted draft content. */
      readonly content: DraftContent
      /** Content restored when the active edit is cancelled. */
      readonly initialContent: DraftContent
    }

/**
 * Owns one draft editing transaction for the current editor controller while
 * preserving committed-or-cancellable content.
 *
 * @remarks
 * Primary category: invariant owner. An idle state contains committed content;
 * an editing state additionally retains the content from editing start.
 * Concurrency model: single-owner. JavaScript object identity stays within one
 * runtime agent, and the constructing editor event-loop owner retains this
 * instance. Every operation is synchronous and invokes no callback, so calls
 * cannot overlap within that owner.
 */
class DraftEditor {
  /** Authoritative editing state replaced by each committed transition. */
  #state: DraftState

  /**
   * Creates a ready idle editor from committed content.
   *
   * @param content - Content stored in the initial idle state.
   */
  public constructor(content: DraftContent) {
    this.#state = {
      status: "idle",
      content
    }
  }

  /**
   * Returns committed content while idle or current uncommitted content while
   * editing.
   *
   * @returns Content visible in the latest complete editor state.
   */
  public get content(): DraftContent {
    return this.#state.content
  }

  /**
   * Replaces the current draft content atomically.
   *
   * While idle, the replacement is committed immediately. While editing, the
   * replacement remains cancellable until editing stops.
   *
   * @param content - Trusted immutable content stored before assignment returns.
   */
  public set content(content: DraftContent) {
    if (content.value === this.#state.content.value) {
      return
    }

    this.#state = {
      ...this.#state,
      content
    }
  }

  /**
   * Returns the current editing lifecycle.
   *
   * @returns `idle` or `editing` from the latest complete state.
   */
  public get status(): DraftStatus {
    return this.#state.status
  }

  /**
   * Starts one cancellable editing transaction from the committed content.
   *
   * Repeated calls while editing preserve the active transaction.
   */
  public startEditing(): void {
    if (this.#state.status === "editing") {
      return
    }

    this.#state = {
      status: "editing",
      content: this.#state.content,
      initialContent: this.#state.content
    }
  }

  /**
   * Commits the current content and returns the editor to idle.
   *
   * Repeated calls while idle preserve the committed content.
   */
  public stopEditing(): void {
    if (this.#state.status === "idle") {
      return
    }

    this.#state = {
      status: "idle",
      content: this.#state.content
    }
  }

  /**
   * Cancels the active edit, restores its initial content, and returns to idle.
   *
   * Repeated calls while idle preserve the committed content.
   */
  public cancelEditing(): void {
    if (this.#state.status === "idle") {
      return
    }

    this.#state = {
      status: "idle",
      content: this.#state.initialContent
    }
  }
}
```

The current editor controller uses the content getter and setter to render and assign content, observes `status` to render editing controls, and invokes all three lifecycle transitions. The class has one connected state machine, one field, seven public operations including construction, no exposed mutable representation, and one runtime-enforced single-owner model.

## Complete Rust example

```rust
use std::marker::PhantomData;
use std::rc::Rc;

/// Immutable text owned by a draft editor.
#[derive(Clone)]
struct DraftContent(String);

/// Current editing lifecycle of one draft editor.
#[derive(Clone, Copy)]
enum DraftStatus {
    /// The editor has no active editing transaction.
    Idle,

    /// The editor has one active editing transaction.
    Editing,
}

/// Private authoritative state of one draft editor.
enum DraftState {
    /// No editing transaction is active.
    Idle {
        /// Last committed draft content.
        content: DraftContent,
    },

    /// One cancellable editing transaction is active.
    Editing {
        /// Current uncommitted draft content.
        content: DraftContent,

        /// Content restored when the active edit is cancelled.
        initial_content: DraftContent,
    },
}

/// Owns one draft editing transaction for the current editor controller while
/// preserving committed-or-cancellable content.
///
/// Primary category: invariant owner. An idle state contains committed content;
/// an editing state additionally retains the content from editing start.
/// Concurrency model: single-owner; the `Rc` marker makes this type neither
/// `Send` nor `Sync`, and mutable operations require exclusive `&mut self` access.
struct DraftEditor {
    /// Authoritative editing state changed only through controlled operations.
    state: DraftState,

    /// Zero-sized marker enforcing retention by one thread owner.
    single_owner: PhantomData<Rc<()>>,
}

impl DraftEditor {
    /// Creates a ready idle editor from committed content.
    fn create(content: DraftContent) -> Self {
        Self {
            state: DraftState::Idle { content },
            single_owner: PhantomData,
        }
    }

    /// Returns committed content while idle or current uncommitted content while
    /// editing.
    fn content(&self) -> &DraftContent {
        match &self.state {
            DraftState::Idle { content } | DraftState::Editing { content, .. } => content,
        }
    }

    /// Replaces the current draft content atomically.
    ///
    /// While idle, the replacement is committed immediately. While editing, the
    /// replacement remains cancellable until editing stops.
    fn set_content(&mut self, content: DraftContent) {
        match &mut self.state {
            DraftState::Idle {
                content: current_content,
            }
            | DraftState::Editing {
                content: current_content,
                ..
            } => {
                if current_content.0 == content.0 {
                    return;
                }

                *current_content = content;
            }
        }
    }

    /// Returns the lifecycle from the latest complete state.
    fn status(&self) -> DraftStatus {
        match self.state {
            DraftState::Idle { .. } => DraftStatus::Idle,
            DraftState::Editing { .. } => DraftStatus::Editing,
        }
    }

    /// Starts one cancellable edit from the committed content.
    ///
    /// Repeated calls while editing preserve the active transaction.
    fn start_editing(&mut self) {
        let content = match &self.state {
            DraftState::Idle { content } => content.clone(),
            DraftState::Editing { .. } => return,
        };

        self.state = DraftState::Editing {
            initial_content: content.clone(),
            content,
        };
    }

    /// Commits the current content and returns the editor to idle.
    ///
    /// Repeated calls while idle preserve the committed content.
    fn stop_editing(&mut self) {
        let content = match &self.state {
            DraftState::Idle { .. } => return,
            DraftState::Editing { content, .. } => content.clone(),
        };

        self.state = DraftState::Idle { content };
    }

    /// Cancels the active edit, restores its initial content, and returns idle.
    ///
    /// Repeated calls while idle preserve the committed content.
    fn cancel_editing(&mut self) {
        let initial_content = match &self.state {
            DraftState::Idle { .. } => return,
            DraftState::Editing {
                initial_content, ..
            } => initial_content.clone(),
        };

        self.state = DraftState::Idle {
            content: initial_content,
        };
    }
}
```

The current editor controller uses the content getter and setter to render and assign content, observes `status` to render editing controls, and invokes all three lifecycle transitions. Rust has no JavaScript property syntax, so its language-equivalent accessors use conventional receiver methods. The zero-sized `PhantomData<Rc<()>>` marker enforces thread confinement, while `&mut self` enforces exclusive state transitions.

## SOLID mapping

- **SRP:** `CLASS-002`, `CLASS-003`, and `CLASS-006`.
- **OCP:** `CLASS-029`, `CLASS-030`, `CLASS-031`, and `CLASS-032`.
- **LSP:** `CLASS-029`, `CLASS-030`, `CLASS-031`, and `CLASS-038`.
- **ISP:** `CLASS-005`, `CLASS-008`, and `CLASS-031`.
- **DIP:** `CLASS-008`, `CLASS-009`, and `CLASS-031`.

## Verification checklist

A class is compliant only when every applicable answer is “yes”:

- [ ] Does the class have a current instance-level reason?
- [ ] Does it own exactly one responsibility?
- [ ] Does it declare one primary category?
- [ ] Does its name identify its owner or mechanism and capability?
- [ ] Does every public operation have current evidence?
- [ ] Does it satisfy every objective limit?
- [ ] Does it have one authoritative named declaration?
- [ ] Are all dependencies explicit and narrow?
- [ ] Is its ownership graph acyclic?
- [ ] Is its direct constructor pure?
- [ ] Does effectful creation use a failure-safe named factory?
- [ ] Is every exposed instance fully ready?
- [ ] Is representation private and minimal?
- [ ] Does state exclude invalid combinations?
- [ ] Does every transition preserve the invariant atomically?
- [ ] Is mutable representation prevented from escaping?
- [ ] Are accessors limited to genuine local properties?
- [ ] Is every getter a synchronous bounded local query?
- [ ] Is every setter a synchronous atomic local assignment?
- [ ] Does derived or cached state have one source of truth?
- [ ] Does every method satisfy the Function standard and require the instance?
- [ ] Is the public API free of mechanism types and handles?
- [ ] Does the class declare and enforce one concurrency model?
- [ ] Do suspension, failure, and cancellation preserve valid state?
- [ ] Do critical sections exclude unknown and unbounded work?
- [ ] Is resource ownership explicit?
- [ ] Is cleanup deterministic, idempotent, and complete?
- [ ] Are lifecycle state and owned background work terminal?
- [ ] Does composition replace repository-owned inheritance?
- [ ] Is externally required inheritance isolated?
- [ ] Do multiple implemented interfaces share one owner and invariant?
- [ ] Are static members limited to approved purposes?
- [ ] Is operational identity separate from domain equality?
- [ ] Is the behavior owner protected from copying?
- [ ] Does serialization use a compliant immutable snapshot?
- [ ] Does documentation define the complete class contract?
- [ ] Are compatibility consequences handled atomically?
- [ ] Do tests cover the complete class contract?
- [ ] Do tests preserve rather than distort the class design?
