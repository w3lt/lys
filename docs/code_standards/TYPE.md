# Type

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

## Definition

A type defines the complete set of values accepted by a contract and the relationships between those values.

A clean type answers:

- What domain concept does this value represent?
- Which values are valid?
- Which states are impossible?
- Which fields appear together?
- Which variants are closed?
- What does absence mean?
- Who may mutate the value?
- How does untrusted data become this type?

Types describe values and data relationships. Interfaces describe behavioral capabilities and substitutable implementations. Classes or semantic class equivalents own the private state, resources, or dependencies that implement behavior.

Renderer-managed state or lifecycle attached to a function or template component does not by itself create a repository-owned Class construct. An actual repository-owned instance that retains state, dependencies, resources, identity, or lifecycle across calls remains a Class construct and MUST follow the [Class](./CLASS.md) chapter.

## Construction recipe

Before creating a type:

1. Name the single domain concept.
2. Enumerate its valid values and states.
3. Identify values and states that must be impossible.
4. Decide whether the domain is a scalar, record, closed variant, collection, or generic relationship.
5. Decide whether structurally identical values need semantic separation.
6. Model absence explicitly.
7. Choose a stable discriminant for closed variants.
8. Define ownership and mutability.
9. Identify the authoritative runtime validation source.
10. Decide whether the type is internal or public.
11. Document its invariants and compatibility contract.
12. Verify that consumers cannot construct invalid values without bypassing the type system.

## Type categories

### Scalar value type

Represents one domain value such as an identifier, unit, name, timestamp, or bounded number.

```ts
type ConversationId = string & {
  readonly __brand: "ConversationId"
}
```

### Record or product type

Represents values that must exist together.

```ts
type Message = {
  readonly id: MessageId
  readonly role: MessageRole
  readonly text: string
}
```

### Closed variant or sum type

Represents one value selected from a complete known set.

```ts
type LoadingState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: Error }
```

### Collection type

Represents multiple values with defined ordering, uniqueness, keying, or mutability semantics.

```ts
type ConversationHistory = readonly Conversation[]
```

### Generic type

Represents a relationship that is independent of a specific contained type.

```ts
type Result<TValue, TError> =
  | { readonly status: "success"; readonly value: TValue }
  | { readonly status: "failure"; readonly error: TError }
```

## Example scope

Rule-specific examples demonstrate only the rule under discussion. Complete examples at the end demonstrate the rules together.

## Mandatory rules

### TYPE-001 — One type, one domain concept

A type MUST represent one domain concept, value relationship, or boundary contract.

A type MUST be split when its fields or variants:

1. Have different domain owners.
2. Have independent lifecycles.
3. Change for unrelated requirements.
4. Can be consumed independently.
5. Share no invariant.

```ts
// Noncompliant
type UserAndConversationData = {
  userId: string
  userEmail: string
  conversationId: string
  conversationTitle: string
}

// Compliant
type User = {
  id: UserId
  email: EmailAddress
}

type Conversation = {
  id: ConversationId
  title: ConversationTitle
}
```

This is the type-level application of SRP.

### TYPE-002 — Model the exact valid value set

A type MUST accept every valid domain value and reject every invalid domain value that the type system can represent.

Broad primitives MUST NOT replace a known closed domain.

```ts
// Noncompliant
type MessageRole = string

// Compliant
type MessageRole = "user" | "assistant" | "system"
```

```rust
// Noncompliant
type MessageRole = String;

// Compliant
enum MessageRole {
    User,
    Assistant,
    System,
}
```

When a constraint cannot be expressed statically, construction or parsing MUST validate it before producing the domain type.

### TYPE-003 — Different meanings require different types

Values with different domain meanings MUST use different types even when they share the same runtime representation.

```ts
// Noncompliant
function getConversation(userId: string, conversationId: string): Conversation {
  // The arguments can be reversed without a type error.
}

// Compliant
type UserId = string & {
  readonly __brand: "UserId"
}

type ConversationId = string & {
  readonly __brand: "ConversationId"
}

function getConversation(
  userId: UserId,
  conversationId: ConversationId
): Conversation {
  // ...
}
```

Rust:

```rust
struct UserId(String);
struct ConversationId(String);

fn get_conversation(
    user_id: UserId,
    conversation_id: ConversationId,
) -> Conversation {
    // ...
}
```

This rule applies to identifiers, units, currencies, encoded values, validated strings, timestamps, versions, and other semantically distinct primitives.

A plain alias that remains interchangeable with the original primitive is insufficient when accidental interchange must be prevented.

### TYPE-004 — Closed domains require closed variants

A known finite domain MUST use an enum, literal union, tagged union, sealed hierarchy, or equivalent closed construct.

It MUST NOT use:

- An unrestricted string.
- An unrestricted number.
- A collection of unrelated Boolean flags.
- Independent constants without a corresponding closed type.
- Optional fields whose presence is used to guess the variant.

```ts
// Noncompliant
type RuntimeState = {
  isStarting: boolean
  isRunning: boolean
  isStopping: boolean
  hasFailed: boolean
}

// Compliant
type RuntimeState =
  | { status: "stopped" }
  | { status: "starting" }
  | { status: "running"; startedAt: Date }
  | { status: "stopping" }
  | { status: "failed"; error: RuntimeError }
```

A Boolean type is appropriate only when the domain has exactly two states, neither state carries different data, and no third state exists.

### TYPE-005 — Invalid states must be unrepresentable

Fields that are required together MUST appear together in one variant.

Fields that are mutually exclusive MUST appear in separate variants.

```ts
// Noncompliant
type ModelState = {
  status: "none" | "loading" | "loaded" | "failed"
  progress?: number
  model?: LoadedModel
  error?: ModelLoadError
}

// Compliant
type ModelState =
  | { readonly status: "none" }
  | { readonly status: "loading"; readonly progressPercent: number }
  | { readonly status: "loaded"; readonly model: LoadedModel }
  | { readonly status: "failed"; readonly error: ModelLoadError }
```

Consumers MUST NOT need comments or runtime checks to discover which optional field combinations are valid.

### TYPE-006 — Discriminants must be explicit and canonical

Every closed variant MUST contain one stable discriminant.

Use:

- `status` for lifecycle or state-machine variants.
- `kind` for structural variants.
- A domain term such as `role`, `operation`, or `channel` when it is more precise.

The discriminant MUST:

- Be required in every variant.
- Use a unique literal value.
- Remain stable across the type's consumers.
- Be sufficient to select the variant.
- Support exhaustive branching.

```ts
// Noncompliant: consumers infer the variant from property presence.
type Message =
  { userName: string; text: string } | { modelName: string; text: string }

// Compliant
type Message =
  | { role: "user"; userName: string; text: string }
  | { role: "assistant"; modelName: string; text: string }
```

A variant MUST NOT require additional property-presence checks after its discriminant is selected.

### TYPE-007 — Absence has one representation per contract

A contract MUST choose one representation for absence and use it consistently.

Valid representations include:

- An optional value.
- A nullable value.
- An `Option` or `Maybe`.
- A named variant such as `{ status: "not-found" }`.

A contract MUST NOT combine multiple absence representations.

```ts
// Noncompliant
type ConversationTitle = string | null | undefined

// Compliant when explicit empty state is persisted
type ConversationTitle = string | null
```

An optional property means omission itself is valid. It MUST NOT be used merely because the property is populated later.

```ts
// Noncompliant
type Connection = {
  status: "connecting" | "connected"
  socket?: Socket
}

// Compliant
type Connection =
  { status: "connecting" } | { status: "connected"; socket: Socket }
```

Empty strings, zeroes, negative numbers, empty collections, and invalid identifiers MUST NOT represent absence unless they are documented domain values.

### TYPE-008 — Untrusted data is not a domain type

External, serialized, persisted, user-provided, dynamically typed, or vendor-provided data MUST be represented as untrusted until validated.

TypeScript MUST use `unknown` rather than asserting the domain type.

```ts
// Noncompliant
const conversation = request.body as Conversation

// Compliant
const conversation = conversationSchema.parse(request.body)
```

A type annotation or assertion does not perform runtime validation.

Rust deserialization into a syntactically valid structure does not prove domain invariants. Fallible conversion into the domain type is required when deserialized values can violate those invariants.

### TYPE-009 — Static and runtime contracts require one source of truth

When a runtime schema and static type describe the same boundary, one MUST derive from the other or both MUST derive from one authoritative declaration.

They MUST NOT be maintained as independent duplicate contracts.

TypeScript:

```ts
// Compliant: the static type derives from the runtime schema.
const conversationSchema = z.object({
  id: conversationIdSchema,
  title: conversationTitleSchema
})

type Conversation = z.infer<typeof conversationSchema>
```

If the domain type is authoritative, the boundary mapper or schema MUST have tests proving it accepts every valid domain representation and rejects incompatible representations.

### TYPE-010 — Mutability must be represented by the type

A type MUST expose whether callers may mutate the value.

Data passed across module, package, process, or API boundaries SHOULD be immutable unless mutation ownership is part of the contract.

```ts
// Noncompliant
type Conversation = {
  id: ConversationId
  messages: Message[]
}

// Compliant immutable contract
type Conversation = {
  readonly id: ConversationId
  readonly messages: readonly Message[]
}
```

A read-only outer field is insufficient when its nested value remains mutable.

Mutable state types MUST identify the owner responsible for preserving their invariants. A shared type MUST NOT imply exclusive mutation ownership to multiple consumers.

### TYPE-011 — Separate values, capabilities, and behavior owners

A closed data shape, union, primitive distinction, tuple, mapped relationship, or generic value container MUST use the language's value-type construct.

A repository-owned substitutable object capability MUST use the language's interface, trait, protocol, or equivalent behavioral construct.

A repository-owned implementation that owns private state, resources, or dependencies across calls MUST satisfy the [Class](./CLASS.md) chapter. Parameter-only behavior MUST remain a function under `FUNC-020`.

In TypeScript:

- A data-only or mixed data-and-behavior `interface` is prohibited.
- A data-only class is prohibited; use a compliant data type.
- A `type` alias whose primary purpose is to expose reusable object operations is prohibited.
- A callback or function value MAY use a function type alias and MAY be carried as a property of a data type.
- A data dependency object MAY contain interface-typed properties without redefining their behavior.

```ts
// Value contract
type Conversation = {
  readonly id: ConversationId
  readonly messages: readonly Message[]
}

// Data contract carrying a callback value
type ConversationPanelProps = {
  readonly conversation: Conversation
  readonly onConversationSelected: (id: ConversationId) => void
}

// Behavioral capability
interface ConversationWriter {
  saveConversation(conversation: Conversation): Promise<void>
}
```

A data type MUST NOT be made open to arbitrary extension when its valid fields and variants are owned by one domain contract.

The [Interface](./INTERFACE.md) chapter defines capability construction rules and the exact callback-carrier boundary. The Class chapter defines when an instance-based implementation such as a `SqliteConversationStore` is permitted.

### TYPE-012 — Type names must use domain vocabulary

A named type MUST use a singular domain noun or a role-specific suffix.

Allowed suffixes include:

- `Id` for identifiers.
- `Input` for validated operation input.
- `Options` for optional operation configuration.
- `Result` for an operation outcome.
- `State` for a state machine.
- `Event` for a historical domain occurrence.
- `Command` for a requested domain action.
- `Error` for a defined failure.
- `Request` and `Response` for transport boundaries.

Names MUST NOT use `Type`, `Interface`, `Data`, `Info`, `Object`, `Struct`, `DTO`, or `Model` when a precise domain name exists.

```ts
// Noncompliant
type ConversationDataType = {
  // ...
}

// Compliant
type Conversation = {
  // ...
}
```

Prefixes such as `IConversation`, `TConversation`, or `ConversationType` MUST NOT encode the language construct in the name.

The same domain concept MUST use the same name across modules and packages.

### TYPE-013 — Generics require a real type relationship

A generic type MUST express a relationship that remains valid for every permitted type argument.

A generic MUST NOT be introduced solely to avoid naming a concrete domain type.

```ts
// Noncompliant: the generic hides a fixed conversation contract.
type Entity<T> = {
  id: string
  value: T
}

type ConversationEntity = Entity<Conversation>

// Compliant when the relationship is genuinely reusable
type Result<TValue, TError> =
  { status: "success"; value: TValue } | { status: "failure"; error: TError }
```

A public type MUST have no more than three generic parameters. More relationships require a named configuration type or decomposition.

Every generic parameter MUST:

- Affect the resulting contract.
- Have a documented semantic role.
- Use the narrowest valid constraint.
- Preserve relationships between at least two positions when that relationship is the reason for the generic.

Unused or phantom generic parameters require a language-specific ownership or type-safety purpose documented in the type contract.

### TYPE-014 — Generic names must communicate their role

Public generic parameters MUST use semantic names such as:

- `TValue`
- `TError`
- `TItem`
- `TKey`
- `TContext`
- `TRequest`
- `TResponse`

Single-letter names such as `T`, `K`, or `V` MAY be used only for a private, conventional container whose full declaration is locally visible.

```ts
// Noncompliant public contract
type Page<T, U> = {
  values: T[]
  next: U
}

// Compliant
type Page<TItem, TCursor> = {
  readonly items: readonly TItem[]
  readonly nextCursor?: TCursor
}
```

### TYPE-015 — Caller-selected generics must be provable

A function MUST NOT allow the caller to select a return type that is not proven by an input, schema, constructor, or implementation contract.

```ts
// Noncompliant: the caller can request any type.
function parseJson<TValue>(text: string): TValue {
  return JSON.parse(text) as TValue
}

// Compliant
function parseJson<TValue>(text: string, schema: Schema<TValue>): TValue {
  return schema.parse(JSON.parse(text))
}
```

A generic return type MUST be determined by an observable input relationship, not by caller assertion.

### TYPE-016 — Composition must preserve compatible invariants

Types MAY be composed only when their fields and invariants are compatible.

Intersections, multiple inheritance, mixins, or flattened compositions MUST NOT combine:

- Conflicting property types.
- Conflicting ownership rules.
- Independent lifecycle states.
- Unrelated domain concepts.
- Multiple discriminants that can contradict one another.

```ts
// Noncompliant
type Loading = {
  status: "loading"
  progressPercent: number
}

type Failed = {
  status: "failed"
  error: Error
}

type InvalidState = Loading & Failed
```

Use a named record when composition creates a new domain concept. Use a closed union when the composed values are alternatives.

### TYPE-017 — Public types are compatibility contracts

An exported type is part of the consumer contract.

Before changing a public type, identify:

- Every producer.
- Every consumer.
- Every implementation.
- Every persisted or serialized representation.
- Every exhaustive branch.
- Every schema and generated artifact.

The following changes MUST be treated as compatibility changes:

- Adding a required field.
- Removing or renaming a field.
- Changing a field's meaning or unit.
- Widening or narrowing accepted values.
- Adding a closed variant.
- Changing absence representation.
- Changing mutability or ownership.
- Changing generic constraints.
- Exposing an internal dependency type.

A public type MUST NOT expose private framework, database, filesystem, vendor, or transport details unless those details are the intentional public contract.

### TYPE-018 — Public contracts require explicit types

Exported functions, methods, fields, constants, and boundaries MUST use explicit parameter and result types.

Local values MAY use inference when the inferred type is precise and immediately visible.

```ts
// Noncompliant public contract
export const findConversation = async (id: ConversationId) =>
  conversationReader.findConversationById(id)

// Compliant
export const findConversation = async (
  id: ConversationId
): Promise<Conversation | undefined> =>
  conversationReader.findConversationById(id)
```

An inferred public type MUST NOT accidentally expose a vendor-specific or implementation-specific type.

### TYPE-019 — Every named type requires API documentation

Every named repository-owned type, enum, union, record, struct, and type alias MUST have an API documentation comment immediately before its declaration.

- JavaScript and TypeScript use JSDoc.
- Rust uses rustdoc.
- Other languages use their standard API documentation format.

Documentation MUST explain applicable domain meaning, validity constraints, units, absence semantics, ownership, mutability, variant relationships, and compatibility or persistence behavior.

Every property or variant requiring information not expressed by its name and type MUST also be documented.

Documentation MUST NOT merely repeat the type syntax.

### TYPE-020 — Assertions must be proven

A type assertion, cast, downcast, non-null assertion, or equivalent unchecked conversion MUST NOT manufacture trust.

An assertion is allowed only when:

1. A runtime check dominating the assertion proves the complete required invariant.
2. The language cannot express the proven relationship.
3. The assertion is located immediately after the proof.
4. The assertion cannot be replaced by a safer standard construct.
5. The proof is documented when it is not evident in the same expression.

```ts
// Noncompliant
const uncheckedConversationId = value as ConversationId

// Allowed when the check proves every ConversationId invariant.
if (typeof value !== "string" || !CONVERSATION_ID_PATTERN.test(value)) {
  throw new InvalidConversationIdError(value)
}

const conversationId = value as ConversationId
```

Prefer a parser that returns the trusted type directly.

Compiler and lint suppressions MUST follow the same proof requirement and remain limited to one expression or declaration.

### TYPE-021 — Refinements must prove their claim

A type guard, refinement, or narrowing function MUST verify every runtime property required by the refined type.

```ts
// Noncompliant: checks only one property.
function isConversation(value: unknown): value is Conversation {
  return typeof value === "object" && value !== null && "id" in value
}

// Compliant
function isConversation(value: unknown): value is Conversation {
  return conversationSchema.safeParse(value).success
}
```

A Boolean type guard is appropriate when callers need only pass/fail information. Use a parser when callers require normalized output or actionable validation errors.

### TYPE-022 — Recursive types require a termination contract

A recursive type MAY be used only when the domain is genuinely recursive.

Its consuming operations MUST define applicable:

- Maximum depth.
- Maximum total nodes.
- Cycle behavior.
- Serialization behavior.
- Traversal order.
- Stack-safety strategy.

```ts
type MessageThread = {
  readonly message: Message
  readonly replies: readonly MessageThread[]
}
```

Untrusted recursive input MUST be bounded during parsing. A recursive type MUST NOT permit unbounded resource consumption merely because the static shape is valid.

### TYPE-023 — Units and encoded formats belong in the type contract

A numeric or string type representing a unit, identifier, encoding, timestamp, currency, or protocol value MUST preserve that meaning.

```ts
// Noncompliant
type Timeout = number

// Compliant
type Milliseconds = number & {
  readonly __brand: "Milliseconds"
}

type RequestTimeout = Milliseconds
```

A format-constrained string MUST become a domain type only after validation.

Examples include:

- UUIDs.
- URLs.
- Email addresses.
- ISO timestamps.
- File paths.
- Model identifiers.
- Encoded tokens.

Different units or encodings MUST NOT share an interchangeable type when accidental substitution would be harmful.

### TYPE-024 — Domain types must not depend on mechanism types

High-level domain types MUST NOT include framework request objects, database rows, filesystem handles, vendor SDK objects, or transport-specific values.

```ts
// Noncompliant domain contract
type Conversation = {
  row: SqliteRow
  request: FastifyRequest
}

// Compliant
type Conversation = {
  readonly id: ConversationId
  readonly messages: readonly Message[]
}
```

Boundary adapters MUST convert mechanism-specific types into domain types.

This is the type-level application of DIP.

### TYPE-025 — Subtypes must preserve the parent contract

A subtype, refinement, implementation value, or derived type MUST remain valid wherever its parent type is accepted.

It MUST NOT:

- Require stronger preconditions.
- Provide weaker postconditions.
- Change field meaning or units.
- Remove valid parent behavior.
- Introduce incompatible failure behavior.
- Change ownership or lifecycle expectations silently.

A function accepting the parent type MUST NOT need to identify which subtype it received.

This is the type-level application of LSP.

### TYPE-026 — Inline object types are limited

An inline object type MAY be used only when it:

- Is private to one declaration.
- Has no independent domain name.
- Has no invariant beyond its field types.
- Contains no more than two fields.
- Is not reused.
- Is not persisted, serialized, exported, or passed across a module boundary.

```ts
// Allowed local shape
function formatPoint(point: { x: number; y: number }): string {
  return `${point.x},${point.y}`
}
```

A larger or externally meaningful shape MUST receive a named type with documentation.

## Complete TypeScript example

```ts
/** Nominal marker for validated conversation identifiers. */
declare const CONVERSATION_ID_BRAND: unique symbol

/**
 * Identifier of one conversation.
 *
 * Values are validated UUID strings and are not interchangeable with other
 * identifiers.
 */
type ConversationId = string & {
  /** Prevents interchange with other validated string identifiers. */
  readonly [CONVERSATION_ID_BRAND]: "ConversationId"
}

/** Observable state of loading one conversation. */
type ConversationLoadState =
  | {
      /** No conversation load has started. */
      readonly status: "idle"
    }
  | {
      /** A conversation is being loaded. */
      readonly status: "loading"
      /** Identifier of the requested conversation. */
      readonly conversationId: ConversationId
    }
  | {
      /** The conversation loaded successfully. */
      readonly status: "loaded"
      /** Loaded conversation. */
      readonly conversation: Conversation
    }
  | {
      /** The conversation could not be loaded. */
      readonly status: "failed"
      /** Identifier whose load failed. */
      readonly conversationId: ConversationId
      /** Failure reported by the application boundary. */
      readonly error: ConversationAccessError
    }
```

This example separates identifiers from raw strings, uses one closed discriminated union, makes invalid field combinations impossible, uses immutable fields, uses canonical lifecycle discriminants, and documents domain meaning and variant contracts.

## Complete Rust example

```rust
/// Identifier of one conversation.
///
/// Values are validated before construction and are not interchangeable with
/// other identifier types.
struct ConversationId(String);

/// Observable state of loading one conversation.
enum ConversationLoadState {
    /// No conversation load has started.
    Idle,

    /// A conversation is being loaded.
    Loading {
        /// Identifier of the requested conversation.
        conversation_id: ConversationId,
    },

    /// The conversation loaded successfully.
    Loaded {
        /// Loaded conversation.
        conversation: Conversation,
    },

    /// The conversation could not be loaded.
    Failed {
        /// Identifier whose load failed.
        conversation_id: ConversationId,

        /// Failure reported by the application boundary.
        error: ConversationAccessError,
    },
}
```

## SOLID mapping

- **SRP:** `TYPE-001`.
- **OCP:** `TYPE-004`, `TYPE-006`, and the explicit closed-versus-open decision in `TYPE-011`.
- **LSP:** `TYPE-025`.
- **ISP:** Data types expose only fields required by their consumers; behavioral segregation is defined by the Interface chapter.
- **DIP:** `TYPE-024`.

## Verification checklist

A type is compliant only when every applicable answer is “yes”:

- [ ] Does it represent one domain concept or value relationship?
- [ ] Does it accept exactly the intended valid value set?
- [ ] Are semantically different primitive values represented by different types?
- [ ] Are finite domains represented as closed variants?
- [ ] Are invalid field combinations unrepresentable?
- [ ] Does every closed variant have one canonical discriminant?
- [ ] Is absence represented exactly one way?
- [ ] Does untrusted data remain untrusted until runtime validation succeeds?
- [ ] Do static and runtime contracts share one authoritative source?
- [ ] Does the type expose ownership and mutability accurately?
- [ ] Are data represented by a value type, substitutable behavior by an interface-equivalent, and behavior ownership by a compliant class-equivalent?
- [ ] Does the name use canonical domain vocabulary without construct prefixes or suffixes?
- [ ] Does every generic express a real relationship with no more than three parameters?
- [ ] Are generic names and constraints meaningful?
- [ ] Is every caller-selected generic result proven by an input or schema?
- [ ] Does composition preserve compatible invariants?
- [ ] Are public compatibility consequences identified?
- [ ] Do public contracts use explicit types?
- [ ] Does every named type have accurate API documentation?
- [ ] Is every assertion immediately supported by a complete proof?
- [ ] Does every refinement verify the complete claimed type?
- [ ] Do recursive types define resource and termination limits?
- [ ] Are units and encoded formats preserved by distinct validated types?
- [ ] Are domain types independent of frameworks and external mechanisms?
- [ ] Do subtypes preserve the parent contract?
- [ ] Are inline object types limited to trivial private shapes?
