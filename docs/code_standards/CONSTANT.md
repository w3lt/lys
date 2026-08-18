# Constant

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

## Definition

A constant is a named binding that is not reassigned after initialization.

There are two forms:

- **Immutable local binding:** Calculated for one execution scope and never reassigned.
- **Shared named constant:** A stable value declared outside an operation and reused across executions.

A constant binding does not automatically make the referenced object deeply immutable. Binding immutability and value immutability must be considered separately.

## Construction recipe

Before creating a constant:

1. Confirm the binding never needs reassignment.
2. Decide whether it belongs to one local operation or is a shared domain value.
3. Place it in the narrowest scope containing every consumer.
4. Initialize it with one valid, final value.
5. Give it a domain name that includes units or boundaries when needed.
6. Identify the authoritative source of the value.
7. Ensure a shared value cannot be mutated by consumers.
8. Ensure initialization performs no hidden I/O or other side effects.
9. Document shared limits, defaults, public values, and compatibility constraints.
10. Test behavior at declared boundaries rather than merely testing the literal.

## Mandatory rules

### CONST-001 — Immutable binding by default

A binding that is not reassigned MUST be declared immutable using the language's applicable construct.

TypeScript:

```ts
// Noncompliant
let conversationId = request.params.id

// Compliant
const conversationId = request.params.id
```

Rust:

```rust
// Noncompliant
let mut conversation_id = request.conversation_id;

// Compliant
let conversation_id = request.conversation_id;
```

Mutability MUST NOT be added in anticipation of a future requirement.

### CONST-002 — Local unless sharing is required

A constant MUST be declared inside the innermost lexical scope containing every consumer.

A constant MAY move to module, class, package, or public scope only when all consumers require the same semantic value.

```ts
// Noncompliant: exported even though only one function uses it.
export const TITLE_SEPARATOR = " — "

export function formatTitle(name: string, subtitle: string): string {
  return `${name}${TITLE_SEPARATOR}${subtitle}`
}

// Compliant
export function formatTitle(name: string, subtitle: string): string {
  const titleSeparator = " — "
  return `${name}${titleSeparator}${subtitle}`
}
```

A shared constant MUST NOT be created merely because a value appears more than once. The occurrences must represent the same domain rule or contract.

### CONST-003 — A constant must name a concept

A constant MUST represent a domain value, limit, default, unit conversion, protocol value, or other named concept.

A constant MUST NOT be a meaningless alias for a literal.

```ts
// Noncompliant
const FIVE = 5
const EMPTY = ""

// Compliant
const MAX_RETRY_ATTEMPTS = 5
const EMPTY_CONVERSATION_TITLE = ""
```

The second example is compliant only if an empty title is a valid, named domain state. If absence is the real state, model absence instead.

### CONST-004 — Domain-specific naming

A constant's name MUST state what the value means.

Names MUST:

- Include units when the type does not encode them.
- Identify whether a value is a minimum, maximum, default, limit, threshold, interval, capacity, or version.
- Name Boolean constants as predicates.
- Distinguish encoded, serialized, display, and domain values when they differ.
- Follow the repository's casing convention for that language and scope.

```ts
// Noncompliant
const TIMEOUT = 5
const LIMIT = 20
const ENABLED = true

// Compliant
const REQUEST_TIMEOUT_MS = 5_000
const MAX_VISIBLE_MESSAGES = 20
const IS_LOCAL_MODEL_ENABLED_BY_DEFAULT = true
```

Rust:

```rust
const REQUEST_TIMEOUT_MS: u64 = 5_000;
const MAX_VISIBLE_MESSAGES: usize = 20;
const IS_LOCAL_MODEL_ENABLED_BY_DEFAULT: bool = true;
```

Local immutable bindings follow ordinary local naming conventions:

```ts
const requestTimeoutMs = config.requestTimeoutMs
```

```rust
let request_timeout_ms = config.request_timeout_ms;
```

### CONST-005 — One authoritative definition

A domain rule MUST have one authoritative constant.

Equivalent constants MUST NOT be independently declared in multiple modules, packages, applications, tests, or schemas.

```ts
// Noncompliant
// backend/title.ts
const MAX_TITLE_LENGTH = 120

// desktop/title.ts
const TITLE_CHARACTER_LIMIT = 100
```

If multiple consumers share the same contract, place the constant in the package or schema that owns that contract and import it from there.

If two values happen to be equal but represent different domain concepts, they MUST remain separate.

```ts
// Compliant: equal values with different meanings.
const MAX_RETRY_ATTEMPTS = 3
const MAX_VISIBLE_SUGGESTIONS = 3
```

### CONST-006 — Shared values must be immutable

A shared constant containing an object, collection, map, set, buffer, or other mutable value MUST prevent consumers from mutating shared state.

Choose one of these designs:

1. Use a transitively immutable value.
2. Expose a read-only value when the language enforces it.
3. Return a new value from a factory.
4. Keep the value private and expose focused read operations.

TypeScript:

```ts
// Noncompliant: consumers can mutate shared defaults.
export const DEFAULT_HEADERS = {
  "content-type": "application/json"
}

// Compliant for this flat object
export const DEFAULT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json"
})
```

For nested mutable data, a shallow read-only type or shallow freeze is insufficient:

```ts
// Compliant: each caller receives independent mutable state.
export function createDefaultRuntimeState(): RuntimeState {
  return {
    messages: [],
    activeModel: null
  }
}
```

Rust:

```rust
// Compliant: consumers receive an immutable shared slice.
pub const SUPPORTED_ROLES: &[Role] = &[Role::User, Role::Assistant];
```

A constant reference MUST NOT be presented as immutable when consumers can still mutate its contents.

### CONST-007 — Deterministic, side-effect-free initialization

Shared constant initialization MUST NOT perform:

- Network access.
- Filesystem access.
- Database access.
- Process creation.
- Logging.
- Environment-dependent discovery.
- Time or randomness reads.
- Registration of listeners, timers, or callbacks.

```ts
// Noncompliant: importing the module performs I/O.
export const DEFAULT_PROMPT = readFileSync(promptPath, "utf8")

// Compliant: loading is explicit.
export function loadDefaultPrompt(promptPath: string): string {
  return readFileSync(promptPath, "utf8")
}
```

A shared constant MAY be computed from other deterministic constants when evaluation has no observable side effects.

### CONST-008 — Configuration is not a constant

A value MUST NOT be encoded as a shared constant when it varies by deployment, user, machine, environment, request, or runtime session.

```ts
// Noncompliant
const BACKEND_URL = "http://localhost:3000"

// Compliant
const backendUrl = config.backendUrl
```

A documented application default MAY be a constant:

```ts
const DEFAULT_BACKEND_PORT = 3000
```

The layer that applies the default MUST remain explicit. Multiple layers MUST NOT apply different defaults for the same setting.

Secrets, credentials, tokens, private keys, and environment-specific identifiers MUST NOT be stored as constants in source code.

### CONST-009 — Defaults must identify their owner

A default constant MUST state:

- Which input or setting it defaults.
- Which layer applies it.
- Under which condition it is used.
- Whether users or callers may override it.

```ts
// Ambiguous
const DEFAULT_TIMEOUT_MS = 5_000

// Concrete
const DEFAULT_MODEL_LOAD_TIMEOUT_MS = 5_000
```

A default MUST NOT conceal:

- Missing required configuration.
- Invalid external input.
- Corrupt persisted data.
- Unsupported protocol versions.
- An unavailable required dependency.

### CONST-010 — Limits require boundary semantics

A limit or threshold constant MUST define whether it is inclusive or exclusive through its name, type, comparison, or documentation.

The implementation and tests MUST agree on the boundary.

```ts
const MAX_MESSAGE_LENGTH = 4_000

if (message.length > MAX_MESSAGE_LENGTH) {
  throw new MessageTooLongError()
}
```

Required tests:

```ts
acceptsMessageWithLength(MAX_MESSAGE_LENGTH)
rejectsMessageWithLength(MAX_MESSAGE_LENGTH + 1)
```

A limit MUST use the same unit and counting model everywhere it is enforced. For example, bytes, Unicode code points, and UTF-16 code units are different measures.

### CONST-011 — Derived constants must preserve one source of truth

A derived constant MAY be calculated from authoritative constants when the relationship is exact and stable.

```ts
const MILLISECONDS_PER_SECOND = 1_000
const DEFAULT_RETRY_DELAY_SECONDS = 5

const DEFAULT_RETRY_DELAY_MS =
  DEFAULT_RETRY_DELAY_SECONDS * MILLISECONDS_PER_SECOND
```

A derived constant MUST NOT duplicate a value that should instead come directly from a schema, type, configuration source, or protocol definition.

The relationship MUST NOT rely on an undocumented approximation.

### CONST-012 — Public constants are API contracts

An exported or public constant is part of the consumer contract.

A public constant MUST document or make explicit:

- Its semantic meaning.
- Its type and unit.
- Whether consumers may persist or transmit it.
- Whether its value may change between compatible releases.
- Any compatibility consequences of changing it.

```ts
/**
 * Current version written to newly created conversation databases.
 *
 * Persisted databases retain this value, so changing it requires a migration.
 */
export const CURRENT_DATABASE_VERSION = databaseMigrations.length
```

Changing a public constant MUST be treated as a contract change when consumers can observe, persist, branch on, or transmit its value.

### CONST-013 — Constants must not replace types

A collection of related constants MUST NOT simulate a closed domain when the language provides a type, enum, union, or equivalent construct that can enforce valid values.

```ts
// Noncompliant
const STATUS_IDLE = "idle"
const STATUS_LOADING = "loading"
const STATUS_FAILED = "failed"

function setStatus(status: string): void {
  // ...
}

// Compliant
type LoadingStatus = "idle" | "loading" | "failed"

function setStatus(status: LoadingStatus): void {
  // ...
}
```

Constants MAY expose runtime values while a type defines the valid domain:

```ts
export const loadingStatuses = ["idle", "loading", "failed"] as const

export type LoadingStatus = (typeof loadingStatuses)[number]
```

The runtime collection and type must derive from one authoritative definition.

### CONST-014 — Constant extraction must improve meaning

A literal SHOULD become a named constant when at least one of these conditions is true:

- It encodes a domain rule.
- It defines a limit, timeout, interval, capacity, version, or unit conversion.
- Multiple consumers must share the exact same semantic value.
- Its meaning is not apparent at the use site.
- Changing it requires coordinated behavior or tests.

A literal SHOULD remain inline when its meaning is already complete and local.

```ts
// Unnecessary extraction
const FIRST_ITEM_INDEX = 0
const firstMessage = messages[FIRST_ITEM_INDEX]

// Clear inline value
const firstMessage = messages[0]
```

## Verification checklist

A constant is compliant only when every applicable answer is “yes”:

- [ ] Is the binding never reassigned?
- [ ] Is it declared in the innermost scope shared by all consumers?
- [ ] Does it name a real domain concept rather than merely alias a literal?
- [ ] Does its name communicate meaning, boundary, and units?
- [ ] Is it the authoritative definition of that domain value?
- [ ] Is a shared object or collection protected against mutation?
- [ ] Is shared initialization deterministic and free of side effects?
- [ ] Is the value genuinely constant rather than runtime configuration?
- [ ] Are defaults owned and applied by one explicit layer?
- [ ] Are limit boundaries and counting units defined and tested?
- [ ] Do derived constants preserve one source of truth?
- [ ] Are public constants treated as observable API contracts?
- [ ] Does a type enforce any closed domain represented by runtime constants?
- [ ] Does extracting the constant improve meaning or consistency?
