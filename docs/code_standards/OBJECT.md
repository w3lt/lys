# Object and Object Literal Standard

An object is a runtime aggregate of named properties created without constructing a repository-owned class. Examples include TypeScript object literals, Rust struct literals, Go struct or map literals, and language-equivalent runtime records.

This chapter governs how object values are categorized, constructed, typed, published, copied, updated, compared, serialized, documented, and tested. It does not define the data or behavioral contract itself; the [Type](./TYPE.md), [Interface](./INTERFACE.md), and [Class](./CLASS.md) chapters retain those responsibilities.

## Construct boundary

This chapter applies to:

- Complete data-record values, inputs, options, dependency records, results, state values, snapshots, configuration values, and boundary projections.
- Closed and open lookup values.
- Named patch values.
- Nonescaping local aggregates.
- Immutable update expressions.
- Stateless object-literal implementations of approved interfaces.

This chapter does not redefine:

| Concern                                                                                    | Authoritative construct                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Data shape, valid values, properties, and invariants                                       | Type, record, struct, enum, or equivalent under [Type](./TYPE.md) |
| Reusable behavioral capability                                                             | Interface or trait under [Interface](./INTERFACE.md)              |
| Behavior that owns mutable state, retained dependencies, resources, identity, or lifecycle | Class or semantic class equivalent under [Class](./CLASS.md)      |
| Binding and write ownership                                                                | [Variable](./VARIABLE.md) and [Constant](./CONSTANT.md)           |
| Callable behavior                                                                          | [Function](./FUNCTION.md)                                         |

Arrays, tuples, sets, repository-owned class instances, built-in or external non-record instances such as dates, buffers, and SDK objects, type declarations, and interface declarations are not Object constructs. Dedicated language map or dictionary values are lookup objects under `OBJECT-026` through `OBJECT-034`, even when the runtime implements them as built-in classes. A containing object still follows every applicable ownership, immutability, trust, and boundary rule when it stores or interacts with an excluded value.

## Construction process

Before constructing or modifying an object:

1. State the object's exact runtime purpose.
2. Select its primary category using the precedence in this chapter.
3. Locate or define the authoritative type or interface contract.
4. Identify each property's semantic source, trust level, unit, encoding, ownership, and absence meaning.
5. Validate untrusted values before construction.
6. Decide whether the key set is static, closed-sparse, or open.
7. Decide whether the complete reachable graph is immutable.
8. Construct nested values before constructing their parent.
9. Assemble one complete valid value in one expression.
10. Use spreads, overrides, patches, and conditional properties only under their dedicated rules.
11. Define semantic identity, equality, hashing, ordering, and serialization when the value participates in them.
12. Publish no mutable alias and no incomplete value.
13. Add authoritative documentation and the category-specific tests required by this chapter.

## Object categories

Every object has exactly one primary category. When several categories appear applicable, the first matching category in this precedence order wins:

1. **Stateless provider:** explicitly implements one approved interface without mutable state, retained dependencies, resources, identity, or lifecycle.
2. **Lookup object:** associates homogeneous values with keys from one declared key domain.
3. **Patch object:** is an intentionally incomplete update for one exact target and operation.
4. **Local aggregate:** groups a cohesive intermediate value that never escapes its function.
5. **Complete value:** completely represents one domain value, input, options object, dependency record, result, state, snapshot, configuration value, or boundary projection.

A mutable or stateful behavioral object literal is prohibited. It must become a compliant class or language-equivalent behavior owner.

## Example scope

Normative rules are language-independent. Examples use TypeScript and Rust to demonstrate concrete language behavior. A `Compliant` or `Prohibited` label applies to the rule being demonstrated; omitted surrounding declarations remain subject to every applicable standard.

## Mandatory rules

### Categories and eligibility

### OBJECT-001 — Objects are runtime values

An object MUST do exactly one of the following:

- Instantiate a data contract governed by the Type chapter.
- Implement one behavioral capability governed by the Interface chapter.
- Form a nonescaping local aggregate permitted by `TYPE-026`.

An object literal MUST NOT redefine, weaken, or substitute for its authoritative contract.

### OBJECT-002 — Every object has one primary category

Every object MUST select exactly one category from this chapter.

“General object,” “miscellaneous data,” “context,” “payload,” “metadata,” “helpers,” and “convenience container” are not categories. A value that changes category according to its current properties is prohibited.

### OBJECT-003 — Object creation requires an exact purpose

Before an object is created, all of these statements MUST be true:

- Its primary category is known.
- Every property is necessary for that purpose.
- Its property set is static, or its dynamic key domain is explicit.
- It is valid immediately after construction.
- Its ownership and mutability are known.
- No existing more precise construct represents the same purpose.

An object MUST NOT be created merely because several values are available at the same location.

### OBJECT-004 — One object represents one cohesive aggregate

Properties belong in one object only when they form one concept and have the same reason to change.

The object MUST be split when property groups differ by:

- Domain owner.
- Operation.
- Lifecycle.
- Permission.
- Mutation owner.
- Persistence or transport boundary.
- Abstraction level.
- Independent reason to change.

A broad noun such as `data`, `options`, `context`, or `state` does not prove cohesion. This rule is the object-level application of SRP.

### OBJECT-005 — Objects must not disguise another construct

An object MUST NOT act as:

- A mutable behavior owner.
- A resource or lifecycle owner.
- A service locator or dependency registry.
- A global mutable singleton.
- A namespace for unrelated functions or constants.
- A substitute for a class that owns state, identity, dependencies, or lifecycle.
- A substitute for a named public type.
- An untyped property bag.
- A way to evade the Function parameter limit.
- A mixture of passive data and unrelated behavior.

A stateless provider object is allowed only with explicit interface conformance under `OBJECT-047` through `OBJECT-054`.

An object that implements behavior MUST become a compliant class or semantic class equivalent when it owns mutable state, retains dependencies across calls, or owns resources, instance identity, or lifecycle.

A passive dependency record MAY carry explicitly declared callback values or interface-typed capabilities under `TYPE-011` and `IFACE-024`. The record itself MUST implement no behavior and own no dependency lifecycle.

```ts
// Prohibited: mutable behavior owner disguised as an object.
const conversationStore = {
  conversations: new Map<ConversationId, Conversation>(),
  saveConversation(conversation: Conversation): void {
    this.conversations.set(conversation.id, conversation)
  }
}
```

### Construction and typing

### OBJECT-006 — Construction is type-checked without manufactured conformance

Every escaping object MUST be checked through at least one of:

- An explicit type annotation.
- A typed parameter or return position.
- TypeScript `satisfies`.
- A named struct, record, or equivalent literal.
- Another complete compile-time conformance mechanism.

Inference without a named contract is permitted only for a nonescaping local aggregate under `TYPE-026`.

Casts, unchecked conversions, `any`, double assertions, partial construction, and equivalent mechanisms MUST NOT manufacture conformance. TypeScript `as const` may narrow a value, but it does not validate the value against a contract.

```ts
const conversation = Object.freeze({
  id: conversationId,
  title: conversationTitle
} satisfies Conversation)
```

### OBJECT-007 — Property sets are exact

A complete value MUST provide every required property exactly once and no undeclared property.

A patch, lookup, or local aggregate MUST match its own exact contract rather than the complete target's property set.

For every optional property:

- Omission MUST have one documented meaning.
- Explicit `undefined` or `null` is allowed only when it belongs to the contract.
- Optionality MUST NOT conceal an invalid, unavailable, or uncomputed required value.

### OBJECT-008 — Objects are complete when created

At the end of its construction expression, an object MUST be valid for its primary category.

The following are prohibited:

- Creating `{}` and assigning properties later.
- Casting a partial value to a complete contract.
- Adding properties after publication.
- Deleting properties to manufacture the intended shape.
- Temporarily storing sentinel or invalid values.
- Exposing an object before validation or derivation completes.

A patch may be incomplete relative to its target, but it MUST be complete for its patch contract.

```ts
// Prohibited: staged complete-value construction.
const conversation = {} as Conversation
conversation.id = conversationId
conversation.title = conversationTitle
```

### OBJECT-009 — Only trusted values enter trusted objects

External, persisted, serialized, dynamically typed, or otherwise untrusted values MUST be validated under `TYPE-008` and `FUNC-007` before they enter a trusted object.

Code MUST NOT:

- Spread untrusted input into a trusted value.
- Cast raw JSON into a domain contract.
- Copy unknown properties and delete unwanted ones.
- Mix trusted and untrusted properties in one trusted aggregate.
- Retain the raw source as a hidden property after validation.

### OBJECT-010 — Every property has one exact source and meaning

Each property value MUST have the same domain meaning, unit, encoding, ownership, and trust level required by the target property.

Property shorthand is allowed only when the source variable has exactly the same semantic name as the target property. When source and target meanings differ, construction MUST show the mapping explicitly.

```ts
const storedCreatedAtIso = formatInstant(message.createdAt)

const storedMessage = Object.freeze({
  messageId: message.id,
  content: message.content,
  createdAtIso: storedCreatedAtIso
} satisfies StoredMessage)
```

### OBJECT-011 — Property declarations are unique and explicit

Except for the controlled override permitted by `OBJECT-020`, one property MUST NOT be supplied more than once through explicit declarations, spreads, or their combination.

A complete value MUST NOT contain:

- Duplicate property names.
- Computed property names.
- Symbols unless an external protocol requires them.
- Prototype-sensitive properties.
- Undocumented conditional presence.

Computed keys are allowed only for a lookup object under `OBJECT-026` through `OBJECT-034` or an isolated external adapter under `OBJECT-061`.

### OBJECT-012 — Construction performs assembly only

An object construction expression MUST assemble already available values at one abstraction level.

Fallible, asynchronous, side-effecting, or multistep work MUST complete before the literal is evaluated. A property expression may perform a pure, bounded, and immediately obvious calculation that does not hide another operation.

```ts
const normalizedTitle = normalizeConversationTitle(rawTitle)
const conversation = {
  id: conversationId,
  title: normalizedTitle
} satisfies Conversation
```

### Properties and immutability

### OBJECT-013 — Published objects are immutable

An object is published when it is:

- Returned or exported.
- Stored in shared or persisted state.
- Passed to code that may retain it.
- Captured by asynchronous work, an event, a stream, an iterator, or a callback.
- Sent to another package, process, API, or external system.

After publication, the object and every update to it MUST be immutable. A change MUST create a new value or occur through a compliant class or semantic state owner.

A `const` binding alone does not make an object immutable.

### OBJECT-014 — Immutability is transitive

Every value reachable from a published object MUST be immutable for the published ownership contract.

Mutable nested arrays, maps, sets, buffers, dates, class references, and equivalent values make the outer object mutable unless the nested value is:

- Replaced by an immutable representation.
- Copied with independent ownership.
- Protected by a language-enforced deep-readonly contract.
- Exposed only through a narrow behavioral capability.

TypeScript `Readonly<T>` and `Object.freeze` are shallow. `as const` is a static narrowing mechanism, not runtime freezing. Object spread is also shallow. Shared constants additionally follow `CONST-006`.

```ts
// Prohibited: the array remains mutable through another alias.
const messages: Message[] = loadMessages()
const conversation = {
  id: conversationId,
  messages
} satisfies Readonly<Conversation>
```

### OBJECT-015 — A mutable object has one temporary owner

Mutation is allowed only as a private construction or calculation detail when all of these conditions hold:

- Exactly one function owns every write.
- The value never escapes that function while mutable.
- No callback, closure, task, iterator, event, or stream captures it.
- It does not cross `await`, `yield`, an event boundary, or an external call.
- Every write is local and auditable.
- It is converted into the final immutable representation before publication.
- Mutation materially simplifies one bounded algorithm.

Persistent, synchronized, invariant-bearing, or lifecycle-dependent mutation requires an explicit state owner. Staged mutation MUST NOT be used merely to avoid complete construction.

### OBJECT-016 — Mutable aliases are prohibited

Two writable owners of the same object or reachable nested value are prohibited.

Code receiving a mutable input and needing to retain or publish it MUST do exactly one of:

- Make an ownership-preserving copy.
- Accept an explicit ownership transfer.
- Convert it into an immutable representation.
- Retain only a narrow capability that protects mutation.

Immutable values may be shared only when the entire reachable graph is immutable.

### OBJECT-017 — Data-object properties are passive

Complete values, patches, local aggregates, and lookup objects MUST contain passive data only.

They MUST NOT contain:

- Getters or setters.
- Methods.
- Proxies or surprising property descriptors.
- Lazy computation.
- I/O or mutation triggered by a read.
- Hidden registration or lifecycle behavior.

A function-valued property is permitted only when its data contract explicitly carries a callback, dependency, prop, or result under `TYPE-011`. It MUST NOT be used to disguise an object method or reusable capability.

A passive dependency record MAY carry interface-typed capabilities under `TYPE-011` and `IFACE-024`. The record itself MUST implement no behavior, retain no hidden dependency, and own no dependency lifecycle.

Stateless provider objects follow `OBJECT-047` through `OBJECT-054` instead.

### OBJECT-018 — Property order follows the authoritative contract

A complete literal MUST follow the property order of its authoritative type or schema.

For a closed variant, use this order:

1. Discriminant.
2. Identity and correlation properties.
3. Required variant properties.
4. Optional metadata.

An operation carrier MUST follow the operation's logical sequence rather than alphabetical order.

Properties MUST NOT be reordered to hide overrides, conditional presence, unrelated groups, or mixed abstraction levels. Object enumeration order MUST NOT represent domain ordering; use an ordered collection when order is semantic.

### Spread, copy, merge, and patch behavior

### OBJECT-019 — Spread accepts only trusted plain records

A spread source MUST be:

- Trusted and validated.
- Statically typed.
- Passive ordinary data.
- The same complete type as the target, or a named non-overlapping subset.
- Free of mutable aliases unless it remains inside one private owner.

A complete or update literal may contain at most one spread in total. A conditional fragment under `OBJECT-022` counts as that one spread.

Code MUST NOT spread:

- `unknown`, `any`, or raw JSON.
- A class instance or provider object.
- An array, map, set, date, buffer, resource, SDK object, or mechanism object.
- A proxy, getter, setter, custom descriptor, prototype-sensitive value, or symbol-sensitive value.

Object rest does not validate or sanitize unknown data.

### OBJECT-020 — Immutable update spreads have explicit precedence

An update such as `{ ...conversation, title }` is allowed only when:

- The source and result have the same named complete-value contract.
- The source is transitively immutable.
- The spread appears before every addition or override.
- Every override is written explicitly and exactly once.
- Every unchanged nested value remains safely immutable.
- The result cannot retain invalid or stale properties.

An update MUST NOT use spread to change a discriminant or lifecycle variant. Code changing variants MUST construct the complete target variant explicitly, without retaining properties from the source variant.

```ts
const renamedConversation = Object.freeze({
  ...conversation,
  title: renamedTitle
} satisfies Conversation)
```

### OBJECT-021 — Multi-source merging requires an explicit policy

Blind precedence merging such as `{ ...defaults, ...stored, ...commandLine }` is prohibited.

A named function MUST define, property by property:

- Source precedence.
- Absence semantics.
- Validation.
- Conflict behavior.
- The resulting complete contract.

`Object.assign`, generic deep-merge utilities, recursive merge utilities, and language-equivalent blind merges are prohibited for repository-owned objects.

An externally imposed merge may occur only in an isolated adapter that returns a validated repository value.

### OBJECT-022 — Conditional properties have exact presence semantics

A conditional property is permitted only when:

- The target contract marks the property optional.
- Omission has one documented meaning.
- The condition expresses that exact meaning.
- The branch adds one property or one inseparable property group.
- Every required property remains unconditional.

Truthiness MUST NOT determine presence when `false`, `0`, an empty string, or an empty collection is valid.

Properties that must appear or disappear together MUST form a closed variant rather than independent conditional properties.

### OBJECT-023 — Patches are named and narrow

A patch MUST have a named contract for one exact target and operation. It may contain only properties that operation is permitted to change.

The patch contract MUST define:

- The meaning of omission.
- Whether explicit `undefined` or `null` is permitted.
- Whether each property is replaced, appended, removed, incremented, or transitioned.
- Whether repeated application is idempotent.

An unrestricted public or cross-module `Partial<T>` is prohibited. A patch MUST NOT be accepted where a complete target value is required.

### OBJECT-024 — Patch application reconstructs the invariant explicitly

A named owner operation MUST validate and apply a patch.

Blind application such as `{ ...target, ...patch }` is prohibited. The operation MUST construct every resulting property explicitly and preserve the target invariant before publishing the result.

Patch application MUST NOT:

- Change identity unless the operation explicitly owns identity replacement.
- Retain stale properties from another variant.
- Treat omission as deletion without a declared contract.
- Recursively merge nested values.
- Mutate part of the target before validation completes.

### OBJECT-025 — Copying defines ownership explicitly

Immutable values SHOULD be shared rather than copied.

Copying is justified only to:

- Establish independent mutation ownership.
- Remove a mutable alias.
- Translate representation.
- Produce an immutable snapshot.
- Transfer ownership across an external boundary.

A named copy or projection operation MUST define which nested values are shared, copied, transferred, or translated.

A shallow spread is not a clone. JSON round-tripping, unqualified structured cloning, reflection-based copying, generic recursive cloning, and prototype cloning are prohibited.

An isolated boundary adapter may use an external copying mechanism only for one exact supported value set with documented and tested ownership semantics.

### Dictionaries and dynamic keys

### OBJECT-026 — Every lookup declares its key-domain mode

A lookup MUST use exactly one key-domain mode:

1. **Closed-total:** a finite known key set in which every key is present.
2. **Closed-sparse:** a finite known key set in which defined keys may be absent.
3. **Open:** keys are discovered at runtime.

The mode MUST be expressed by the lookup contract and MUST NOT change according to the current contents.

A lookup MUST NOT mix named domain properties with dynamic entries.

### OBJECT-027 — Closed key domains are exact

For a closed-total lookup:

- Every allowed key MUST appear exactly once.
- Missing keys and additional keys are prohibited.
- Exhaustiveness MUST be checked by the language or type system.

For a closed-sparse lookup:

- Only declared keys are permitted.
- The meaning of a missing key MUST be documented.
- A dedicated sparse-lookup contract MUST be used instead of `Partial` applied to an unrelated domain object.

When different keys require different value types or meanings, the value is a structured data object and MUST use named properties rather than a lookup.

```ts
type DeliveryChannel = "email" | "sms"

const retryLimitByChannel = Object.freeze({
  email: 3,
  sms: 2
} satisfies Readonly<Record<DeliveryChannel, number>>)
```

### OBJECT-028 — Open key domains use a dedicated map construct

An open runtime key domain MUST use the language's dedicated map or dictionary construct, such as TypeScript `Map` or Rust `HashMap`.

A plain object with arbitrary string keys is permitted only when an external serialization or storage contract requires that representation. It MUST remain inside the boundary adapter, be validated, and be converted to the repository representation immediately.

A dedicated map is mandatory when:

- Keys are not canonical strings.
- Key identity or equality matters.
- Entries are frequently added or removed.
- Size, ordering, or iteration behavior matters.
- The key set can grow during execution.

### OBJECT-029 — Keys are validated and canonicalized once

Every external or dynamically produced key MUST be validated before lookup or insertion.

The key contract MUST define every applicable rule for:

- Case sensitivity.
- Whitespace.
- Unicode normalization.
- Numeric encoding.
- Allowed characters and length.
- Reserved values.

Canonicalization MUST happen once at the trust boundary. Code MUST NOT normalize the same key differently at individual read or write sites.

Collisions created by canonicalization MUST be rejected unless the contract defines another explicit deterministic policy. Silent last-write-wins behavior is prohibited. A display value that differs from the canonical key MUST be stored separately.

### OBJECT-030 — Lookup entries are homogeneous

Every entry in a lookup MUST have the same:

- Semantic key meaning.
- Semantic value meaning.
- Value contract.
- Ownership model.
- Trust level.
- Lifecycle.

Metadata, control flags, fallback values, and special sentinel entries MUST NOT be stored beside ordinary entries.

`Record<string, unknown>` and language-equivalent generic property bags are prohibited as repository-owned domain representations.

### OBJECT-031 — Lookup reads express absence

Reads from closed-sparse and open lookups MUST return an explicit absence result such as `Value | undefined`, `Option<Value>`, or a language-equivalent result.

Code MUST:

- Handle absence explicitly.
- Distinguish absence from every valid falsy value.
- Use own-entry membership rather than prototype-chain membership.
- Apply a default only when the contract defines that default.

Non-null assertions, unchecked indexing, truthiness-based existence checks, and defaults that silently hide missing required entries are prohibited.

If `undefined`, `null`, or an equivalent value is valid stored data, the representation MUST provide a separate unambiguous membership operation.

```rust
if let Some(message) = messages_by_id.get(&message_id) {
    render_message(message);
}
```

### OBJECT-032 — Dynamic writes are safe

An untrusted or runtime-derived key MUST NOT be assigned to a prototype-bearing object.

Dedicated map operations or a validated prototype-safe boundary representation MUST be used. Dangerous or reserved keys, including JavaScript `__proto__`, `prototype`, and `constructor`, MUST be rejected where applicable.

Object spread, object rest, copying, and type assertions MUST NOT be treated as key validation or protection against prototype pollution.

### OBJECT-033 — Published lookups are immutable

A lookup may be mutated only as a private, single-owner builder under `OBJECT-015`.

Before publication:

- Construction MUST be complete.
- No writable alias may remain.
- Keys and values MUST satisfy their final contracts.
- The lookup MUST expose an immutable representation or narrow read capability.

A long-lived mutable registry, cache, index, or shared lookup is a state or resource owner and MUST use a compliant class or language-equivalent owner. It is not a plain object.

### OBJECT-034 — Observable iteration is deterministic

When iteration affects API output, persistence, hashing, logs, tests, rendering, or another externally observable result, ordering MUST be explicitly defined and enforced.

Code MUST NOT rely accidentally on object property order, hash-map order, or insertion order. Insertion order is permitted only when it belongs to the declared contract and the selected construct guarantees it.

A required sort MUST define its properties, direction, tie-breaking behavior, and applicable normalization or locale.

### Identity, equality, hashing, and serialization

### OBJECT-035 — Reference identity does not represent domain identity

A memory address or runtime reference MUST NOT determine whether two data objects represent the same domain entity.

Domain identity MUST use an explicit immutable identifier. Reconstructing, copying, spreading, or deserializing an entity does not create a new entity when its identifier remains unchanged. Creating a new entity requires the designated identity-creation operation.

A value object has value semantics and MUST NOT acquire entity identity merely because it occupies a distinct allocation.

Reference identity is permitted only for private non-semantic operations, such as memoization or cycle detection, when changing the allocation cannot affect domain behavior or observable output.

TypeScript object `===`, Rust pointer equality, and language equivalents MUST NOT implement domain identity. Class instances additionally follow `CLASS-033`.

### OBJECT-036 — Every comparison declares its relation

Object comparisons MUST distinguish between:

1. The same domain entity.
2. Equal domain values or state.
3. Equal serialized representations.
4. The same runtime allocation.

These relations MUST NOT substitute for one another. A named comparator or exact language equality contract MUST identify the relation being tested.

Serialized-text equality, hash equality, and runtime-reference equality MUST NOT be used as proof of domain equality.

### OBJECT-037 — Structural equality requires exact value semantics

Generated, derived, or structural equality is permitted only when:

- Both operands have the same named complete-value contract.
- Both object graphs are transitively immutable.
- Every property participates in equality.
- Every nested property has compatible equality semantics.
- Ordering, absence, numeric edge cases, and encodings have exact meanings.

Otherwise, a focused domain comparator MUST define the participating properties and the relation it implements.

Generic reflection-based deep equality is prohibited in production behavior. Tests may use deep equality to verify an exact expected representation, but it MUST NOT define domain semantics.

Language behavior does not define the domain relation. For example, TypeScript dates and arrays compare by reference, `NaN !== NaN`, and absent properties differ from explicit `undefined`; Rust may derive field equality, but floating-point `NaN` prevents ordinary equivalence. Approximate equality MUST NOT be presented as a transitive `Eq` contract.

### OBJECT-038 — Hashing, keying, membership, and deduplication agree with equality

An object participating in hashing, keying, membership, deduplication, or caching MUST use the same declared semantic relation throughout.

- Equal keys MUST produce equal hashes.
- Key properties MUST be transitively immutable.
- Hashes MUST NOT be treated as collision-free proof of equality.
- Composite keys MUST use a structured or canonical encoding rather than ambiguous string concatenation.

Ordering MAY use a relation different from semantic equality, but it MUST declare its own sort properties, directions, normalization, and deterministic tie-breakers. It MUST use the semantic equality relation when an ordered set or ordered map uses ordering to determine key identity.

TypeScript data objects MUST NOT be domain keys in `Map` or `Set`, because those constructs compare object keys by reference. Use an immutable identifier or canonical scalar key. `WeakMap` is permitted only for private non-semantic metadata or memoization.

Rust `Eq` and `Hash` implementations MUST use the same immutable properties and semantics.

### OBJECT-039 — Only named passive representations are serialized

Only a named passive-data contract may cross a serialization boundary.

A domain value may be serialized directly only when its named type is intentionally also the serialized compatibility contract. Otherwise, code MUST construct an explicit named boundary projection.

The following MUST NOT be serialized directly:

- Provider objects.
- Callbacks, methods, accessors, or proxies.
- Resources or lifecycle owners.
- Class instances; classes use immutable snapshots under `CLASS-035`.
- Nonescaping local aggregates.
- Arbitrary repository objects selected for convenience.

### OBJECT-040 — Serialized properties are allowlisted

One authoritative boundary contract MUST define every emitted:

- Property.
- External property name.
- Discriminant.
- Unit and encoding.
- Optional, missing, and null meaning.
- Collection representation.
- Lookup-key representation.

Serialization MUST construct the permitted representation directly.

Reflecting over a broader object and then deleting, omitting, or blacklisting internal properties is prohibited. Spreading a domain object into a boundary payload is also prohibited.

Framework derives or serializer annotations are allowed only on a type explicitly designated as the boundary representation, including a domain type only under the direct-serialization exception in `OBJECT-039`. They MUST preserve the authoritative contract required by `TYPE-009`.

### OBJECT-041 — Serialization does not silently omit, coerce, or invent values

A serializer MUST either preserve the declared meaning or return an explicit failure before producing a successful result. Contractually defined omission of an optional property is the only omission exception.

Values with special serialization behavior MUST be explicitly encoded or rejected. This includes language equivalents of:

- `undefined`.
- Non-finite numbers.
- Arbitrary-precision integers.
- Dates and times.
- Binary data.
- Sparse collections.
- Maps and sets.
- Functions and symbols.
- Custom serialization methods.
- Cyclic references.

In TypeScript, code MUST account explicitly for JSON behavior that omits `undefined`, functions, and symbols; converts non-finite numbers; rejects `bigint`; transforms dates; loses maps and sets; and executes `toJSON` or getters.

In Rust, skip/default/flatten behavior and custom serializer or deserializer functions MUST be part of the named boundary contract. They MUST NOT silently hide data, create property collisions, guess a variant, invent a value for a required or corrupt property, or change units. A default is permitted only when the authoritative compatibility contract explicitly defines absence as that value.

### OBJECT-042 — Deserialization establishes trust explicitly

Serialized input is untrusted. Deserialization MUST:

1. Parse into an untrusted representation.
2. Select the exact supported schema and, when `OBJECT-045` applies, its version.
3. Validate properties, values, invariants, and relationships.
4. Map the validated representation into the repository contract.
5. Publish only the complete valid result.

A cast, typed parser result, generated decoder, or syntactically valid object does not establish domain validity unless it checks every required invariant.

Unknown properties MUST be rejected by default. An explicit forward-compatibility contract may ignore them at the boundary, but they MUST NOT enter the internal object.

### OBJECT-043 — Serialization consumes a stable object graph

Serialization MUST read one complete, transitively immutable snapshot. It MUST NOT traverse a mutable builder or an object that can change during traversal.

Runtime aliases, shared references, prototypes, and memory identity MUST NOT be assumed to survive serialization. A relationship that must survive MUST be represented through explicit immutable identifiers.

Cycles are prohibited unless a named recursive graph contract under `TYPE-022` explicitly represents and validates them. Deserialization MUST NOT publish a partially linked graph.

### OBJECT-044 — Round-trip behavior is declared

A lossless representation MUST satisfy:

```text
deserialize(serialize(value)) is domain-value-equal to value
```

If serialization intentionally redacts, normalizes, aggregates, approximates, or discards information, the result MUST use a differently named projection contract and MUST NOT claim lossless round-trip behavior.

### OBJECT-045 — Long-lived serialized data is versioned explicitly

Data that may be read by another deployment or software version, including persisted records, queued messages, caches, events, and external payloads, MUST have one exactly identifiable schema version.

The version may be carried by the object, an envelope, or an authoritative protocol boundary.

Code MUST NOT infer a version from missing properties or try multiple schemas until one succeeds. Unsupported versions MUST fail explicitly. Migrations MUST be named, ordered, and validated before producing the current internal object.

### OBJECT-046 — Byte-level semantics require canonical encoding

When serialized bytes or text are used for signing, hashing, cache keys, idempotency, deduplication, equality, or deterministic snapshots, the encoding MUST define:

- Property and lookup-key ordering.
- String and Unicode normalization.
- Number representation.
- Missing versus null representation.
- Collection ordering.
- Binary encoding.
- Schema version.

Default serializer output, TypeScript `JSON.stringify`, object insertion order, and hash-map iteration order MUST NOT be assumed to be canonical.

```ts
const updatedAtIso = formatInstant(conversation.updatedAt)

const storedConversation = Object.freeze({
  schemaVersion: 1,
  id: conversation.id,
  title: conversation.title,
  updatedAtIso
} satisfies StoredConversationV1)
```

### Stateless behavioral provider objects

### OBJECT-047 — A provider object satisfies every eligibility condition

A runtime object may implement behavior only when:

1. A current interface already exists and is justified under `IFACE-003`.
2. The language can verify direct value conformance.
3. The implementation owns no data, configuration, dependency, resource, cache, mutable state, identity, or lifecycle.
4. It requires no construction, initialization, synchronization, or disposal.
5. It is valid and ready immediately when defined.
6. One reusable value represents the complete implementation.

If the implementation owns state, dependencies, resources, identity, or lifecycle, it MUST use a compliant class or semantic class equivalent. If it depends only on explicit parameters and implements no approved interface, it MUST use a standalone function. If the language cannot verify interface conformance on a value, it MUST use the language's compliant type-based provider construct.

### OBJECT-048 — A provider object implements exactly one interface

The object MUST expose exactly the required operations of one approved interface.

It MUST NOT contain:

- Additional public operations.
- Optional or conditional operations.
- Private helper methods.
- Data or metadata properties.
- Configuration values.
- Provider-identification properties.
- Debug or test controls.
- Methods belonging to another capability.

An interface containing getters or setters requires a live invariant owner under `CLASS-017`, `CLASS-018`, and `CLASS-019`; it MUST NOT use a stateless provider object.

### OBJECT-049 — Provider conformance is named and explicit

A production provider object MUST:

- Be assigned directly to one named immutable constant.
- Use the implementation naming convention required by `IFACE-009`.
- Declare conformance using the language's strongest mechanism under `IFACE-028`.
- Be constructed in one literal expression.
- Be documented as a provider of that interface.

TypeScript MUST use an explicit annotation or `satisfies Interface`. Casts, assertions, spreads, incremental property assignment, and anonymous inline provider objects are prohibited.

The provider is published when defined and MUST satisfy `OBJECT-013`. A `const` binding without an immutable provider value is insufficient.

### OBJECT-050 — Provider methods do not depend on receiver identity

A provider method MUST NOT read, write, compare, publish, or otherwise depend on `this`, `self`, the provider object, or its runtime identity.

A receiver required by language syntax may exist, but it MUST contribute no state or behavioral variation. Extracting or rebinding a method MUST NOT change its behavior.

### OBJECT-051 — Provider objects do not capture retained values

A provider object MUST NOT be created by a factory or closure that captures:

- Dependencies.
- Configuration.
- Mutable variables.
- Request-specific values.
- Resources.
- Caches.
- Lifecycle state.
- Provider-specific identity.

Methods may call documented module-level functions and use transitively immutable constants.

A method may access a global mechanism only when that mechanism is the provider's declared implementation boundary, requires no hidden configuration or lifecycle, and preserves the complete interface contract.

### OBJECT-052 — Provider behavior remains stateless and reentrant

After every method call, the provider MUST have exactly the same observable state as before the call.

A provider method MUST NOT:

- Mutate the provider.
- Mutate shared state.
- Mutate an input without explicit ownership transfer.
- Lazily initialize state.
- Cache results.
- Count calls.
- Register persistent callbacks.
- Start unowned background work.
- Require calls to be serialized.

Every operation MUST be safe for overlapping or reentrant invocation. Behavior requiring synchronization or retained coordination belongs to a class or resource owner.

Declared external effects remain permitted only when the interface contract explicitly requires them.

### OBJECT-053 — Every provider method follows the Function and Interface standards

Every provider method MUST satisfy every applicable `FUNC-*` and `IFACE-*` rule, including:

- Canonical naming.
- One responsibility.
- One abstraction level.
- Exact input and result contracts.
- Exact side effects and completion semantics.
- Provider-independent absence and failure.
- Required API documentation.

Implementation helpers MUST be named module-level functions. They MUST NOT be hidden as additional provider members.

### OBJECT-054 — One provider implementation has one stable value

A stateless provider implementation MUST be defined once at module scope and reused.

It MUST NOT be recreated:

- Per function call.
- Per request.
- Per render.
- Per component instance.
- Per dependency-object construction.
- Merely to obtain a different runtime identity.

The composition root selects and injects the stable provider value. If separate configured instances are required, the implementation is not a stateless provider object and MUST use another compliant construct.

```ts
/**
 * Formats conversations as Markdown without retaining state or dependencies.
 *
 * @remarks Implements {@link ConversationFormatter} as a stateless, reentrant
 * provider.
 */
const markdownConversationFormatter = Object.freeze({
  /**
   * Formats one conversation using Markdown heading syntax.
   *
   * @param conversation - Immutable conversation to format.
   * @returns Newly owned Markdown presentation.
   */
  formatConversation(conversation: Conversation): FormattedConversation {
    return formatMarkdownConversation(conversation)
  }
} satisfies ConversationFormatter)
```

Rust trait implementations attach to types rather than individual struct-literal values. A stateless Rust implementation MUST use a zero-sized struct with an explicit trait implementation or another compliant semantic class equivalent. That construct follows the Class standard rather than manufacturing a map of callbacks.

### Limits, documentation, testing, and external contracts

### OBJECT-055 — Objective limits are mandatory

Every object MUST remain within these limits:

| Measurement                                               | Required value |
| --------------------------------------------------------- | -------------: |
| Primary object category                                   |              1 |
| Authoritative named contract for an escaping object       |              1 |
| Properties in a nonescaping local aggregate               |              2 |
| Complete or update-object spreads                         |            0–1 |
| Blind multi-source merge spreads                          |              0 |
| Nested object construction in a data-property initializer |              0 |
| Provider interfaces                                       |              1 |
| Provider non-operation properties                         |              0 |
| Provider retained values                                  |              0 |
| Provider values per implementation                        |              1 |
| Post-publication writes                                   |              0 |
| Writable owners after publication                         |              0 |
| Unvalidated dynamic keys or spread sources                |              0 |

The conditional fragment permitted by `OBJECT-022` is the only nested-construction exception and counts as the literal's one permitted spread.

`IFACE-006` exclusively owns the provider operation-count limit. A provider object exposes exactly the operations required by its one interface under `OBJECT-048`.

Complete values, patches, and closed lookups do not receive an arbitrary property-count limit. Their exact property set is governed by their authoritative named contract and `TYPE-001`. Code MUST NOT manufacture artificial wrapper objects merely to evade a numeric limit.

### OBJECT-056 — Nested values are constructed separately

A data-property initializer inside an object literal MUST NOT contain another object construction expression, directly or through an array, conditional expression, or call argument.

The nested value MUST be:

- Constructed and validated first.
- Assigned a name that states its role.
- Passed into the parent literal as one complete value.

Provider method bodies are separate function bodies and do not count as nested property construction.

```ts
const author: Author = {
  id: authorId,
  displayName
}

const message: Message = {
  id: messageId,
  author,
  content
}
```

This construction keeps one abstraction level in each literal.

### OBJECT-057 — Documentation lives with the authoritative contract

Documentation MUST be attached to the construct that owns the meaning:

- Domain-property meaning belongs to the named type.
- Patch semantics belong to the patch type and applying operation.
- Serialization meaning belongs to the boundary contract.
- Shared lookup semantics belong to the named constant and lookup contract.
- Provider behavior belongs to the interface, provider object, and methods.
- Local assembly details belong to the containing function when they are genuinely non-obvious.

Every shared or exported object value MUST satisfy the Constant documentation rules. Every provider object and method MUST satisfy the Function, Interface, and JSDoc documentation rules.

A local literal does not require a comment when its type, property names, and sources make its purpose exact. A comment MUST NOT compensate for an unclear category, unsafe spread, mixed responsibility, or ambiguous property.

### OBJECT-058 — Runtime construction is tested by category

A literal whose correctness is completely enforced by the compiler does not require a dedicated runtime test.

Runtime construction or transformation logic MUST test every applicable category behavior:

- **Complete value:** validation, derived properties, optional-property branches, and invariants.
- **Patch:** omission, null or undefined semantics, permitted changes, prohibited changes, conflicts, and invariant-preserving application.
- **Lookup:** total-key coverage, sparse or open-key absence, normalization, collision handling, reserved keys, and observable ordering.
- **Copy or projection:** nested sharing, copying, ownership transfer, redaction, and alias removal.
- **Serialization:** valid input, malformed input, unknown properties, unsupported versions, round trips, intentional loss, and canonical output.
- **Provider:** the unchanged interface contract suite required by `IFACE-032` plus mechanism-specific behavior.
- **Mutable builder:** ownership isolation and conversion into the final immutable value.

A test is required only for behavior that exists. Tests MUST NOT be added merely to execute static property assignments.

### OBJECT-059 — Tests assert semantic behavior

Tests MUST use the object's declared semantic relation.

They MUST NOT use:

- Reference equality for value or entity equality.
- `JSON.stringify` as a general equality comparison.
- Incidental property or hash-map iteration order.
- Raw snapshots as the only assertion of domain behavior.
- Hash equality as proof of value equality.
- Private builder mutations as the tested public contract.

Exact serialized bytes or snapshots are appropriate only when canonical representation is itself part of the contract.

### OBJECT-060 — Fixtures and builders obey production construction rules

Test objects are not exempt.

A fixture or builder MUST:

- Produce a complete valid named value by default.
- Accept only explicitly permitted variation.
- Preserve every invariant.
- Use named patch semantics for updates.
- Keep invalid external input untrusted.
- Avoid unsafe casts and unchecked conversions.

The following are prohibited:

- A universal “object mother” with unrelated defaults.
- `Partial<T>` overrides applied through blind spread.
- Casting an incomplete literal to the target type.
- Silently generating required identity, timestamps, or permissions irrelevant to the test.
- Sharing mutable nested fixtures between tests.
- Adding production-only setters or controls for fixture construction.

Invalid-input tests MUST build the raw boundary representation rather than manufacture an invalid trusted domain object.

### OBJECT-061 — Externally imposed object shapes are isolated

A framework, language runtime, or third-party API may require an object shape that violates repository categories, such as a callback table containing framework-required metadata.

Such an object is permitted only when:

1. The external contract genuinely requires the shape.
2. It is created inside one boundary adapter.
3. It contains only exact externally required members.
4. Repository data and behavior are mapped explicitly.
5. It declares conformance to the external contract.
6. It does not escape into domain or application code.
7. Its integration is compile-time checked or tested.

This narrow interoperability exception does not permit repository-owned contracts to copy the external design.

## Objective limits

For every repository-owned object:

| Check                                                      | Required value |
| ---------------------------------------------------------- | -------------: |
| Primary category                                           |              1 |
| Authoritative named contract for an escaping object        |              1 |
| Nonescaping local-aggregate properties                     |              2 |
| Complete or immutable-update spreads                       |            0–1 |
| Blind multi-source merge spreads                           |              0 |
| Nested object constructions in a data-property initializer |              0 |
| Provider interfaces                                        |              1 |
| Provider non-operation properties                          |              0 |
| Provider retained values                                   |              0 |
| Stable values per provider implementation                  |              1 |
| Post-publication writes                                    |              0 |
| Writable owners after publication                          |              0 |
| Unvalidated dynamic keys or spread sources                 |              0 |

`OBJECT-022` owns the sole nested conditional-fragment exception. `OBJECT-055` owns all counting semantics.

`IFACE-006` exclusively owns the provider operation-count limit. A provider object exposes exactly the operations required by its one interface under `OBJECT-048`.

## Complete TypeScript example

```ts
/** Supported units for temperature ranges. */
type TemperatureScale = "celsius" | "fahrenheit"

/**
 * Complete immutable temperature interval in one declared scale.
 *
 * @remarks Both boundaries are finite, `minimum` is at or above absolute zero
 * for `scale`, and `minimum` does not exceed `maximum`.
 */
type TemperatureRange = {
  /** Unit used by both boundaries. */
  readonly scale: TemperatureScale
  /** Inclusive lower boundary in the declared scale. */
  readonly minimum: number
  /** Inclusive upper boundary in the declared scale. */
  readonly maximum: number
}

/** Candidate values to validate while constructing one temperature range. */
type BuildTemperatureRangeInput = {
  /** Unit used by both boundaries. */
  readonly scale: TemperatureScale
  /** Inclusive lower boundary in the declared scale. */
  readonly minimum: number
  /** Inclusive upper boundary in the declared scale. */
  readonly maximum: number
}

/**
 * One exact, nonempty update permitted for a temperature range.
 *
 * @remarks Each variant requires exactly one non-null replacement and
 * preserves the other boundary. Optional replacement properties and explicit
 * `null` or `undefined` are prohibited. Reapplying a successful patch produces
 * a semantically equal range.
 */
type TemperatureRangePatch =
  | {
      /** Selects replacement of only the lower boundary. */
      readonly kind: "replace-minimum"
      /** New inclusive lower boundary in the range's existing scale. */
      readonly minimum: number
    }
  | {
      /** Selects replacement of only the upper boundary. */
      readonly kind: "replace-maximum"
      /** New inclusive upper boundary in the range's existing scale. */
      readonly maximum: number
    }

/**
 * Absolute lower temperature by scale.
 *
 * Each value uses the unit identified by its exhaustive key.
 */
const ABSOLUTE_MINIMUM_TEMPERATURE_BY_SCALE = Object.freeze({
  celsius: -273.15,
  fahrenheit: -459.67
} satisfies Readonly<Record<TemperatureScale, number>>)

/**
 * Gets the absolute lower temperature for one scale.
 *
 * @param scale - Scale whose physical lower boundary is required.
 * @returns The absolute minimum expressed in the selected scale.
 */
function getAbsoluteMinimumTemperature(scale: TemperatureScale): number {
  return ABSOLUTE_MINIMUM_TEMPERATURE_BY_SCALE[scale]
}

/**
 * Builds one complete immutable temperature range.
 *
 * @param input - Scale and inclusive boundaries for the range.
 * @returns A new transitively immutable range.
 * @throws {RangeError} If a boundary is non-finite, physically impossible, or
 * inverted.
 */
function buildTemperatureRange(
  input: BuildTemperatureRangeInput
): TemperatureRange {
  if (!Number.isFinite(input.minimum)) {
    throw new RangeError("The minimum temperature must be finite.")
  }

  if (!Number.isFinite(input.maximum)) {
    throw new RangeError("The maximum temperature must be finite.")
  }

  const absoluteMinimum = getAbsoluteMinimumTemperature(input.scale)

  if (input.minimum < absoluteMinimum) {
    throw new RangeError("The minimum temperature is below absolute zero.")
  }

  if (input.minimum > input.maximum) {
    throw new RangeError("The minimum temperature exceeds the maximum.")
  }

  return Object.freeze({
    scale: input.scale,
    minimum: input.minimum,
    maximum: input.maximum
  } satisfies TemperatureRange)
}

/**
 * Updates one boundary while preserving the complete range invariant.
 *
 * @param range - Existing valid immutable range.
 * @param patch - One exact boundary replacement.
 * @returns A new complete range; the original remains unchanged.
 * @throws {RangeError} If the replacement would violate the range invariant.
 */
function updateTemperatureRange(
  range: TemperatureRange,
  patch: TemperatureRangePatch
): TemperatureRange {
  switch (patch.kind) {
    case "replace-minimum":
      return buildTemperatureRange({
        scale: range.scale,
        minimum: patch.minimum,
        maximum: range.maximum
      })

    case "replace-maximum":
      return buildTemperatureRange({
        scale: range.scale,
        minimum: range.minimum,
        maximum: patch.maximum
      })
  }
}

/**
 * Determines whether two ranges represent the same semantic value.
 *
 * @param leftRange - First valid immutable range.
 * @param rightRange - Second valid immutable range.
 * @returns Whether scale and both inclusive boundaries are equal.
 */
function isTemperatureRangeEqual(
  leftRange: TemperatureRange,
  rightRange: TemperatureRange
): boolean {
  return (
    leftRange.scale === rightRange.scale &&
    leftRange.minimum === rightRange.minimum &&
    leftRange.maximum === rightRange.maximum
  )
}
```

The complete example uses one closed-total lookup, validates before construction, publishes only frozen primitive-property graphs, applies a named closed patch through full reconstruction, and defines value equality explicitly. Finite-number validation excludes `NaN`; the equality contract intentionally treats `-0` and `0` as equal.

## Complete Rust example

```rust
/// Supported units for temperature ranges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TemperatureScale {
    /// Degrees Celsius.
    Celsius,
    /// Degrees Fahrenheit.
    Fahrenheit,
}

/// Complete immutable temperature interval in one declared scale.
///
/// Both boundaries are finite, `minimum` is at or above absolute zero for
/// `scale`, and `minimum` does not exceed `maximum`.
#[derive(Debug)]
struct TemperatureRange {
    /// Unit used by both boundaries.
    scale: TemperatureScale,
    /// Inclusive lower boundary in the declared scale.
    minimum: f64,
    /// Inclusive upper boundary in the declared scale.
    maximum: f64,
}

/// Candidate values to validate while constructing one temperature range.
#[derive(Debug)]
struct BuildTemperatureRangeInput {
    /// Unit used by both boundaries.
    scale: TemperatureScale,
    /// Inclusive lower boundary in the declared scale.
    minimum: f64,
    /// Inclusive upper boundary in the declared scale.
    maximum: f64,
}

/// One exact, nonempty update permitted for a temperature range.
///
/// Each variant requires exactly one replacement and preserves the other
/// boundary. No optional replacement exists. Reapplying a successful patch
/// produces a semantically equal range.
#[derive(Debug)]
enum TemperatureRangePatch {
    /// Replaces only the inclusive lower boundary.
    ReplaceMinimum {
        /// New boundary in the range's existing scale.
        minimum: f64,
    },
    /// Replaces only the inclusive upper boundary.
    ReplaceMaximum {
        /// New boundary in the range's existing scale.
        maximum: f64,
    },
}

/// Expected failures while constructing or updating a temperature range.
#[derive(Debug, PartialEq, Eq)]
enum TemperatureRangeError {
    /// The lower boundary is not finite.
    MinimumNotFinite,
    /// The upper boundary is not finite.
    MaximumNotFinite,
    /// The lower boundary is below absolute zero for its scale.
    MinimumBelowAbsolute,
    /// The lower boundary exceeds the upper boundary.
    MinimumAboveMaximum,
}

/// Exact closed lookup containing the absolute minimum for every scale.
struct AbsoluteMinimumTemperatureByScale {
    /// Absolute minimum in degrees Celsius.
    celsius: f64,
    /// Absolute minimum in degrees Fahrenheit.
    fahrenheit: f64,
}

/// Absolute lower temperature for every supported scale.
const ABSOLUTE_MINIMUM_TEMPERATURE_BY_SCALE: AbsoluteMinimumTemperatureByScale =
    AbsoluteMinimumTemperatureByScale {
        celsius: -273.15,
        fahrenheit: -459.67,
    };

/// Gets the absolute lower temperature for one scale.
///
/// Returns the boundary expressed in the selected scale.
fn get_absolute_minimum_temperature(scale: TemperatureScale) -> f64 {
    match scale {
        TemperatureScale::Celsius => ABSOLUTE_MINIMUM_TEMPERATURE_BY_SCALE.celsius,
        TemperatureScale::Fahrenheit => ABSOLUTE_MINIMUM_TEMPERATURE_BY_SCALE.fahrenheit,
    }
}

/// Builds one complete immutable temperature range.
///
/// Returns an error when a boundary is non-finite, physically impossible, or
/// inverted.
fn build_temperature_range(
    input: BuildTemperatureRangeInput,
) -> Result<TemperatureRange, TemperatureRangeError> {
    if !input.minimum.is_finite() {
        return Err(TemperatureRangeError::MinimumNotFinite);
    }

    if !input.maximum.is_finite() {
        return Err(TemperatureRangeError::MaximumNotFinite);
    }

    let absolute_minimum = get_absolute_minimum_temperature(input.scale);

    if input.minimum < absolute_minimum {
        return Err(TemperatureRangeError::MinimumBelowAbsolute);
    }

    if input.minimum > input.maximum {
        return Err(TemperatureRangeError::MinimumAboveMaximum);
    }

    Ok(TemperatureRange {
        scale: input.scale,
        minimum: input.minimum,
        maximum: input.maximum,
    })
}

/// Updates one boundary while preserving the complete range invariant.
///
/// Returns a new value without modifying the original range. Returns an error
/// when the replacement would violate the range invariant.
fn update_temperature_range(
    range: &TemperatureRange,
    patch: TemperatureRangePatch,
) -> Result<TemperatureRange, TemperatureRangeError> {
    let updated_input = match patch {
        TemperatureRangePatch::ReplaceMinimum { minimum } => BuildTemperatureRangeInput {
            scale: range.scale,
            minimum,
            maximum: range.maximum,
        },
        TemperatureRangePatch::ReplaceMaximum { maximum } => BuildTemperatureRangeInput {
            scale: range.scale,
            minimum: range.minimum,
            maximum,
        },
    };

    build_temperature_range(updated_input)
}

/// Determines whether two ranges represent the same semantic value.
///
/// Equality includes the scale and both inclusive boundaries. Finite-value
/// validation excludes `NaN`; positive and negative zero are equal.
fn is_temperature_range_equal(
    left_range: &TemperatureRange,
    right_range: &TemperatureRange,
) -> bool {
    left_range.scale == right_range.scale
        && left_range.minimum == right_range.minimum
        && left_range.maximum == right_range.maximum
}
```

Rust uses a named struct plus exhaustive `match` for the finite closed lookup rather than a hash map. The range does not derive `Eq` because it contains floating-point values; validation excludes non-finite values, and the focused comparator states the intended semantic relation.

## Verification checklist

- [ ] Is the runtime value an Object construct under this chapter's boundary?
- [ ] Does it have exactly one primary category?
- [ ] Is its exact purpose stated by its contract, name, and use?
- [ ] Do all properties form one cohesive aggregate with one reason to change?
- [ ] Is it free of disguised state, lifecycle, service-location, namespace, or class responsibilities?
- [ ] Does every escaping value conform to one named Type or Interface contract without a cast?
- [ ] Is every required property present exactly once and every optional absence exact?
- [ ] Is the object complete and valid at the end of one construction expression?
- [ ] Were all untrusted values validated before entering the object?
- [ ] Does every property have the exact required source, meaning, unit, encoding, ownership, and trust level?
- [ ] Are duplicate, computed, symbolic, prototype-sensitive, and undocumented conditional properties absent or explicitly permitted?
- [ ] Does construction perform assembly at one abstraction level only?
- [ ] Is every published reachable value immutable?
- [ ] Does any temporary mutable object have exactly one local owner and no escape path?
- [ ] Are writable aliases absent?
- [ ] Are data-object properties passive?
- [ ] Does property order reveal the authoritative contract and variant structure?
- [ ] Is every spread source trusted, passive, typed, and permitted?
- [ ] Does an immutable update use one source, source-first precedence, and explicit overrides?
- [ ] Is every multi-source policy implemented property by property in a named function?
- [ ] Do conditional properties implement exact documented absence semantics?
- [ ] Is every patch named, narrow, operation-specific, and explicit about omission and update semantics?
- [ ] Does patch application reconstruct and validate the complete resulting invariant?
- [ ] Does every copy define nested ownership and avoid generic cloning?
- [ ] Does every lookup declare closed-total, closed-sparse, or open mode?
- [ ] Are closed keys exact and open keys represented by a dedicated map?
- [ ] Are dynamic keys validated, canonicalized once, collision-safe, and prototype-safe?
- [ ] Are lookup entries homogeneous and metadata-free?
- [ ] Do sparse and open reads handle absence explicitly?
- [ ] Is every published lookup immutable and every observable iteration deterministic?
- [ ] Does domain identity use an explicit immutable identifier rather than runtime reference identity?
- [ ] Does every comparison identify entity, value, representation, or allocation semantics?
- [ ] Do equality, hashing, keying, membership, and deduplication use one compatible immutable relation?
- [ ] Does ordering declare exact sort properties and deterministic tie-breakers, using equality only when ordered membership treats it as key identity?
- [ ] Does serialization use a named passive boundary contract and an allowlisted projection?
- [ ] Are special values encoded or rejected without silent omission, coercion, or invention?
- [ ] Does deserialization validate an exact schema and every applicable version before publishing a trusted value?
- [ ] Is the serialized graph a stable immutable snapshot with explicit relationships?
- [ ] Is lossless or intentionally lossy round-trip behavior declared and tested?
- [ ] Is long-lived serialized data versioned without shape guessing?
- [ ] Is every byte-semantic encoding canonical rather than serializer-default dependent?
- [ ] Does a provider object satisfy every stateless-provider eligibility condition?
- [ ] Does it implement exactly one interface with no data, helpers, captures, receiver dependence, or hidden state?
- [ ] Is provider conformance explicit and its one stable value injected by the composition root?
- [ ] Does every provider operation follow the Function and Interface standards and remain reentrant?
- [ ] Does the object satisfy every objective limit?
- [ ] Are nested object values constructed separately?
- [ ] Is documentation attached to the authoritative type, operation, boundary, constant, or provider?
- [ ] Do tests cover applicable category behavior and assert semantic rather than incidental behavior?
- [ ] Do fixtures preserve production invariants without partial casts or blind overrides?
- [ ] Is any externally imposed nonconforming shape isolated to one exact tested adapter?
